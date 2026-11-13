#!/usr/bin/env python3
"""米家体脂秤数据可用性探针（只读、只在本机跑）。

用途：确认 `suzi.scales.s600`（苏子智能体脂秤 S600）能否通过米家
eco/scale 云接口拿到历史体测记录。只报告「有没有数据 / 几条 / 有哪些字段」，
**不打印任何健康数值、不打印凭据、默认不写文件**。

凭据只从环境变量读，不进命令行、不进仓库、不进聊天：
  MI_SERVICE_TOKEN   sid=xiaomiio 的 serviceToken（不是 xiaomihome 的）
  MI_SSECURITY       登录会话密钥
  MI_USER_ID         小米账号 userId / uid

拿凭据的现成工具：Squachen/micloud（mc.login() 后 get_token()）或
PiotrMachowski/Xiaomi-cloud-tokens-extractor。注意 serviceToken 按 sid 分域，
用错域会返回 401 {"code":2}。

用法：
  python mi-scale-probe.py --selftest          # 不联网，只自检签名算法
  python mi-scale-probe.py                     # 默认 model=suzi.scales.s600, region=cn
  python mi-scale-probe.py --model yunmai.scales.ms103
  python mi-scale-probe.py --out body.json     # 确认可用后才导出完整 JSON（敏感文件）

依赖：无，仅 Python 3.10+ 标准库（RC4 与 HTTP 都自己实现，不装第三方包）。
"""

import argparse
import base64
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

URI = "/eco/common/scale/getUserDataByPage"
HOSTS = {
    "cn": "api.io.mi.com",
    "de": "de.api.io.mi.com",
    "us": "us.api.io.mi.com",
    "sg": "sg.api.io.mi.com",
    "ru": "ru.api.io.mi.com",
    "i2": "in.api.io.mi.com",
}


def _decode_key(value: str) -> bytes:
    """ssecurity 在不同工具里可能是 base64 或 64 位 hex，两种都兼容。"""
    try:
        return base64.b64decode(value, validate=True)
    except Exception:
        try:
            return bytes.fromhex(value)
        except Exception as exc:
            raise ValueError("MI_SSECURITY 既不是 base64 也不是 hex") from exc


def generate_nonce() -> str:
    raw = os.urandom(8) + (int(time.time()) // 60).to_bytes(4, "big")
    return base64.b64encode(raw).decode()


def signed_nonce(ssecurity: str, nonce: str) -> str:
    digest = hashlib.sha256(_decode_key(ssecurity) + base64.b64decode(nonce)).digest()
    return base64.b64encode(digest).decode()


def rc4_drop1024(key_b64: str, data: bytes) -> bytes:
    """纯标准库实现 RC4-drop1024，避免引入 pycryptodome。"""
    key = base64.b64decode(key_b64)
    s = list(range(256))
    j = 0
    for i in range(256):
        j = (j + s[i] + key[i % len(key)]) & 0xFF
        s[i], s[j] = s[j], s[i]
    i = j = 0

    def keystream(n: int):
        nonlocal i, j
        out = bytearray()
        for _ in range(n):
            i = (i + 1) & 0xFF
            j = (j + s[i]) & 0xFF
            s[i], s[j] = s[j], s[i]
            out.append(s[(s[i] + s[j]) & 0xFF])
        return out

    keystream(1024)  # 丢弃前 1024 字节密钥流
    ks = keystream(len(data))
    return bytes(a ^ b for a, b in zip(data, ks))


def sign_request(uri: str, params: dict, snonce: str) -> dict:
    plain_str = "&".join(f"{k}={v}" for k, v in sorted(params.items()))
    rc4_hash = hashlib.sha1(f"{uri}&{snonce}&{plain_str}".encode()).hexdigest()

    enc = {
        k: base64.b64encode(rc4_drop1024(snonce, str(v).encode())).decode()
        for k, v in sorted(params.items())
    }
    enc_str = "&".join(f"{k}={v}" for k, v in sorted(enc.items()))
    signature = hashlib.sha1(f"{uri}&{snonce}&{enc_str}".encode()).hexdigest()

    enc["rc4_hash__"] = rc4_hash
    enc["signature"] = signature
    enc["_nonce"] = snonce
    enc["ssecurity"] = snonce  # 注意：这里放 signed nonce，不是原始 ssecurity
    return enc


def _collect_records(node, found):
    """在未知结构的响应里找出测量记录列表。"""
    if isinstance(node, dict):
        has_metric = any(k in node for k in ("weight", "Weight", "bodyData", "bodyFat", "fat"))
        has_time = any(k in node for k in ("createTime", "time", "timestamp", "date", "Data"))
        if has_metric and has_time:
            found.append(node)
            return
        for v in node.values():
            _collect_records(v, found)
    elif isinstance(node, list):
        for v in node:
            _collect_records(v, found)


def _field_names(records):
    keys = set()
    for rec in records[:5]:
        body = rec.get("bodyData") if isinstance(rec.get("bodyData"), dict) else rec
        keys.update(body.keys())
    # 时间/标识类字段不算体成分指标
    drop = {"createTime", "time", "timestamp", "date", "Data", "id", "uid", "model", "user", "User"}
    return sorted(k for k in keys if k not in drop)


def selftest():
    snonce = signed_nonce(base64.b64encode(b"0123456789abcdef").decode(), generate_nonce())
    signed = sign_request(URI, {"uid": "1", "pageNum": "1", "pageSize": "200", "startTime": "0"}, snonce)
    assert len(signed["signature"]) == 40, "signature 长度异常"
    assert len(signed["rc4_hash__"]) == 40, "rc4_hash__ 长度异常"
    assert "ssecurity" in signed and "_nonce" in signed
    print("selftest OK：nonce / signed_nonce / RC4-drop1024 / 双 SHA-1 全部可运行")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--model", default="suzi.scales.s600")
    ap.add_argument("--region", default="cn", choices=sorted(HOSTS))
    ap.add_argument("--out", default="", help="确认可用后才写完整 JSON；文件含敏感健康数据")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    token = os.environ.get("MI_SERVICE_TOKEN", "").strip()
    ssecurity = os.environ.get("MI_SSECURITY", "").strip()
    user_id = os.environ.get("MI_USER_ID", "").strip()
    missing = [n for n, v in (("MI_SERVICE_TOKEN", token), ("MI_SSECURITY", ssecurity), ("MI_USER_ID", user_id)) if not v]
    if missing:
        print("缺少环境变量：" + ", ".join(missing))
        print("请只在本机用环境变量设置，不要写进命令行或文件。")
        return 2

    snonce = signed_nonce(ssecurity, generate_nonce())
    body = sign_request(
        URI,
        {"uid": user_id, "pageNum": "1", "pageSize": "200", "startTime": "0"},
        snonce,
    )
    host = HOSTS[args.region]
    headers = {
        "Cookie": f"serviceToken={token}; userId={user_id}",
        "MIOT-REQUEST-MODEL": args.model,
        "User-Agent": f"Android-7.1.1-1.0.0-ONEPLUS A3010-136-{user_id} APP/com.xiaomi.smarthome",
        "Content-Type": "application/x-www-form-urlencoded",
    }

    payload_bytes = urllib.parse.urlencode(body).encode()
    req = urllib.request.Request(
        f"https://{host}/app{URI}", data=payload_bytes, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            status = resp.status
            text = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        status = exc.code
        text = exc.read().decode("utf-8", "replace")
    except Exception as exc:
        print(f"网络错误：{type(exc).__name__}（凭据未输出）")
        return 1

    print(f"HTTP {status} | model={args.model} | region={args.region}")
    if status != 200:
        # 只回显不含凭据的错误摘要
        print("响应摘要：" + text[:200].replace(token, "***"))
        return 1

    try:
        payload = json.loads(text)
    except Exception:
        print("响应不是 JSON，前 200 字符：" + text[:200])
        return 1

    records = []
    _collect_records(payload, records)
    if not records:
        print("返回 0 条记录 → 这个 model 不走 eco/scale 子系统，或区域/凭据/接口已变。")
        print("顶层字段（不含值）：" + ", ".join(sorted(payload.keys())) if isinstance(payload, dict) else "")
        return 1

    dates = []
    for rec in records:
        for k in ("createTime", "time", "timestamp", "date", "Data"):
            if k in rec:
                dates.append(str(rec[k]))
                break
    print(f"记录条数：{len(records)}")
    print("体成分字段：" + ", ".join(_field_names(records)))
    if dates:
        print(f"时间字段样例（原始格式）：{dates[0]} … {dates[-1]}")
    print("结论：接口可用，可以把完整 JSON 交给 FitLife 导入。" if args.out else
          "结论：接口可用。加 --out body.json 可导出完整数据（敏感文件，妥善保管）。")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        print(f"已写入 {args.out}（生成于 {datetime.now(timezone.utc).isoformat()}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
