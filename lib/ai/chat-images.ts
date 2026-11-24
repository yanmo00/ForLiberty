import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";
import type { AIMessageImage } from "../types";

/**
 * 聊天图片持久化。
 *
 * 背景：图片本体原本只放在组件内的 useRef（data URI），页面一卸载就没了，
 * 重进只能看到灰色占位图。AsyncStorage 又不适合放大 base64（会有容量/性能问题），
 * 所以把图片写到 App 文档目录，消息里只存一个 file:// uri。
 *
 * Web 预览没有 FileSystem.documentDirectory，退回直接用 data URI（浏览器内存里能显示，
 * 刷新后丢失可以接受）。
 */

const DIR_NAME = "ai-chat-images";

function dir(): string | null {
  if (Platform.OS === "web") return null;
  const base = FileSystem.documentDirectory;
  return base ? `${base}${DIR_NAME}/` : null;
}

function extFor(mimeType: string): string {
  if (/png/i.test(mimeType)) return "png";
  if (/webp/i.test(mimeType)) return "webp";
  if (/gif/i.test(mimeType)) return "gif";
  return "jpg";
}

/** data URI -> 去掉头部的纯 base64 */
function stripDataUri(uri: string): string {
  const comma = uri.indexOf(",");
  return comma >= 0 ? uri.slice(comma + 1) : uri;
}

/**
 * 把一组 data URI 图片写到文档目录，返回可直接给 <Image source> 用的元信息数组。
 * 写失败的单张会退回 data URI，保证界面仍能显示。
 */
export async function persistChatImages(
  messageId: string,
  images: { uri: string; name?: string; mimeType: string }[]
): Promise<AIMessageImage[]> {
  const folder = dir();
  if (!folder) {
    // Web：直接用 data URI，刷新页面后失效但预览场景可接受
    return images.map((img) => ({ name: img.name, mimeType: img.mimeType, uri: img.uri }));
  }

  try {
    const info = await FileSystem.getInfoAsync(folder);
    if (!info.exists) await FileSystem.makeDirectoryAsync(folder, { intermediates: true });
  } catch {
    // 目录准备失败就退回 data URI
    return images.map((img) => ({ name: img.name, mimeType: img.mimeType, uri: img.uri }));
  }

  const result: AIMessageImage[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const path = `${folder}${messageId}_${i}.${extFor(img.mimeType)}`;
    try {
      await FileSystem.writeAsStringAsync(path, stripDataUri(img.uri), {
        encoding: FileSystem.EncodingType.Base64,
      });
      result.push({ name: img.name, mimeType: img.mimeType, uri: path });
    } catch {
      result.push({ name: img.name, mimeType: img.mimeType, uri: img.uri });
    }
  }
  return result;
}

/**
 * 把消息里的本地 uri 还原成 data URI（重新生成时要再发给视觉模型）。
 * 已经是 data URI 的原样返回；file:// 从磁盘读回 base64。
 */
export async function toDataUriForRecognition(uri: string): Promise<string> {
  if (uri.startsWith("data:")) return uri;
  if (Platform.OS === "web") return uri;
  try {
    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const mime = extFor(uri.split(".").pop() || "");
    return `data:image/${mime === "jpg" ? "jpeg" : mime};base64,${base64}`;
  } catch {
    return uri;
  }
}

/** 删除某条消息对应的本地图片文件（删除消息 / 清空对话时调用） */
export async function deleteChatImages(messageId: string): Promise<void> {
  const folder = dir();
  if (!folder) return;
  try {
    const info = await FileSystem.getInfoAsync(folder);
    if (!info.exists) return;
    const files = await FileSystem.readDirectoryAsync(folder);
    await Promise.all(
      files
        .filter((name) => name.startsWith(`${messageId}_`))
        .map((name) => FileSystem.deleteAsync(`${folder}${name}`, { idempotent: true }))
    );
  } catch {
    // 清理失败不影响主流程
  }
}

/** 删除整个图片目录（清空对话时） */
export async function clearAllChatImages(): Promise<void> {
  const folder = dir();
  if (!folder) return;
  try {
    await FileSystem.deleteAsync(folder, { idempotent: true });
  } catch {
    // ignore
  }
}
