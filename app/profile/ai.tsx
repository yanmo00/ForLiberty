import { useState, useRef, useEffect, useMemo } from "react";
import { Text, View, TouchableOpacity, TextInput, FlatList, Alert, ActivityIndicator, KeyboardAvoidingView, Platform } from "react-native";
import { useRouter } from "expo-router";
import { ScreenContainer } from "@/components/screen-container";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useColors } from "@/hooks/use-colors";
import { useApp } from "@/lib/app-context";
import type { AIMessage, AIConfig } from "@/lib/types";
import Markdown from "react-native-markdown-display";
import { buildAISnapshot } from "@/lib/ai/data-model";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import {
  TOKENHUB_BASE_URL,
  TOKENHUB_CONSOLE_URL,
  TOKENHUB_DEFAULT_MODEL,
  TOKENHUB_WEB_PROXY_URL,
  normalizeBaseUrl,
} from "@/constants/ai-provider";

type AIProvider = AIConfig["provider"];

const PROVIDERS: { value: AIProvider; label: string; defaultUrl: string; defaultModel: string }[] = [
  { value: "tokenhub", label: "智云 TokenHub", defaultUrl: TOKENHUB_BASE_URL, defaultModel: TOKENHUB_DEFAULT_MODEL },
  { value: "openai", label: "OpenAI", defaultUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" },
  { value: "dashscope", label: "阿里百炼", defaultUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen-turbo" },
  { value: "kimi", label: "Kimi (月之暗面)", defaultUrl: "https://api.moonshot.cn/v1", defaultModel: "moonshot-v1-8k" },
  { value: "custom", label: "自定义", defaultUrl: "", defaultModel: "" },
];

// 浏览器有同源策略，网关又不给 CORS 头 → Web 走本机代理，真机直连
function resolveBaseUrl(url: string): string {
  const base = normalizeBaseUrl(url);
  return Platform.OS === "web" && base === TOKENHUB_BASE_URL ? TOKENHUB_WEB_PROXY_URL : base;
}

function describeFailure(status: number, body: string): string {
  const lower = body.toLowerCase();
  if (status === 401 || status === 403)
    return "Key 无效或没权限。到控制台「个人中心 → 账户管理 → 密钥管理」重新复制，别带空格/换行。";
  if (status === 429)
    return "额度用尽或触发限流。到「财务管理 → 费用中心」看余额。";
  if (status === 404 || lower.includes("model"))
    return "模型名不对（教程里的 qwen3.7-max 只是图例）。点「查模型名」拿真实 ID 填进高级设置。";
  return `HTTP ${status}：${body.slice(0, 160)}`;
}

function describeNetworkError(msg: string): string {
  if (/failed to fetch|network request failed|load failed|networkerror/i.test(msg))
    return "浏览器跨域被拦，或本机代理没启动。Web 预览请用 npm run dev:web 启动（含代理）；手机 App 不受此限制。";
  return `连接错误：${msg}`;
}

// react-native-web 的 Alert.alert 是空函数，Web 上点了完全没反应。
// 所有反馈改成页面内可见的结果条；真机仍额外弹原生 Alert。
type Notice = { kind: "success" | "error" | "info"; title: string; text: string };
function noticeKind(title: string): Notice["kind"] {
  if (title.includes("成功")) return "success";
  if (title.includes("失败") || title.includes("错误")) return "error";
  return "info";
}

export default function AIScreen() {
  const colors = useColors();
  const router = useRouter();
  const { state, updateAIConfig, addAIMessage, clearAIMessages } = useApp();
  const flatListRef = useRef<FlatList>(null);
  
  // 配置状态
  const [showConfig, setShowConfig] = useState(!state.aiConfig.isConfigured);
  const [provider, setProvider] = useState<AIProvider>(state.aiConfig.provider || "tokenhub");
  const [baseUrl, setBaseUrl] = useState(state.aiConfig.baseUrl || TOKENHUB_BASE_URL);
  const [model, setModel] = useState(state.aiConfig.model || TOKENHUB_DEFAULT_MODEL);
  // 已保存的 Key 永不回显到输入框；留空表示沿用旧 Key
  const [apiKey, setApiKey] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [modelList, setModelList] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);

  const notify = (title: string, text: string) => {
    setNotice({ kind: noticeKind(title), title, text });
    if (Platform.OS !== "web") notify(title, text);
  };
  
  // 对话状态
  const [inputText, setInputText] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // 当provider变化时更新默认值
  useEffect(() => {
    const providerConfig = PROVIDERS.find(p => p.value === provider);
    if (providerConfig && provider !== "custom") {
      setBaseUrl(providerConfig.defaultUrl);
      setModel(providerConfig.defaultModel);
    }
  }, [provider]);

  const generateSystemPrompt = () => buildSystemPrompt(buildAISnapshot(state));

  // 测试API连接：结果写进页面内结果条，Web 上也能看见（Alert 在 Web 是空函数）
  const handleTestConnection = async () => {
    const effectiveKey = apiKey.trim() || state.aiConfig.apiKey || "";
    if (!effectiveKey) {
      setShowConfig(true);
      notify("提示", "还没配置 API Key：在配置面板粘贴 Key 后再测（Web 预览刷新后要重新粘贴）。");
      return;
    }

    const usedModel = model || state.aiConfig.model || TOKENHUB_DEFAULT_MODEL;
    const target = `${resolveBaseUrl(baseUrl)}/chat/completions`;
    const started = Date.now();
    setIsTesting(true);
    setNotice(null);
    try {
      const response = await fetch(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${effectiveKey}`,
        },
        body: JSON.stringify({
          model: usedModel,
          messages: [{ role: "user", content: "只回复两个字：收到" }],
          max_tokens: 10,
        }),
      });
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      // 网关 401/429 返回 text/plain，json() 会失败，先按纯文本读
      const body = await response.text().catch(() => "");

      if (response.ok) {
        let reply = "";
        let servedModel = "";
        try {
          const parsed = JSON.parse(body);
          reply = String(parsed.choices?.[0]?.message?.content ?? "").trim();
          servedModel = String(parsed.model ?? "");
        } catch {
          // 非 JSON 响应也算连通
        }
        notify(
          "成功 · 测试连接通过",
          [
            `HTTP ${response.status} · 耗时 ${elapsed}s`,
            `请求地址：${target}`,
            `模型：${servedModel || usedModel}`,
            reply ? `模型回复：${reply.slice(0, 60)}` : "已收到模型响应",
          ].join("\n")
        );
      } else {
        let message: string = body;
        try {
          message = JSON.parse(body)?.error?.message || body;
        } catch {
          // 纯文本错误
        }
        notify(
          "失败 · 测试连接未通过",
          `HTTP ${response.status} · 耗时 ${elapsed}s · 模型 ${usedModel}\n${describeFailure(response.status, message || response.statusText)}`
        );
      }
    } catch (error) {
      notify("错误 · 测试连接未通过", describeNetworkError(error instanceof Error ? error.message : "未知错误"));
    } finally {
      setIsTesting(false);
    }
  };

  // 拉一次 /v1/models，拿模型广场里的真实 ID（教程图例名不一定可用）
  const handleListModels = async () => {
    const effectiveKey = apiKey.trim() || state.aiConfig.apiKey || "";
    if (!effectiveKey) {
      notify("提示", "请先粘贴 API Key");
      return;
    }
    try {
      const response = await fetch(`${resolveBaseUrl(baseUrl)}/models`, {
        headers: { "Authorization": `Bearer ${effectiveKey}` },
      });
      const body = await response.text().catch(() => "");
      if (!response.ok) {
        notify("失败", describeFailure(response.status, body));
        return;
      }
      const ids: string[] = (JSON.parse(body)?.data ?? []).map((m: { id?: string }) => m.id || "").filter(Boolean);
      if (!ids.length) {
        notify("提示", "接口没返回模型列表，去模型广场手动复制模型名。");
        return;
      }
      setModelList(ids.slice(0, 20));
    } catch (error) {
      notify("错误", describeNetworkError(error instanceof Error ? error.message : "未知错误"));
    }
  };

  // 保存配置：其余参数已内置，用户只填 Key
  const handleSaveConfig = async () => {
    const effectiveKey = apiKey.trim() || state.aiConfig.apiKey || "";
    if (!effectiveKey) {
      notify("提示", "请先粘贴 API Key");
      return;
    }

    try {
      await updateAIConfig({
        provider,
        baseUrl: normalizeBaseUrl(baseUrl),
        apiKey: effectiveKey,
        model: model || TOKENHUB_DEFAULT_MODEL,
        isConfigured: true,
      });
      setApiKey(""); // 立刻清掉输入框，不留在屏幕上
      setShowConfig(false);
      notify("成功", "配置已保存");
    } catch {
      notify("错误", "保存失败");
    }
  };

  // 发送消息
  const handleSendMessage = async () => {
    if (!inputText.trim()) return;
    if (!state.aiConfig.isConfigured) {
      notify("提示", "请先配置API Key");
      setShowConfig(true);
      return;
    }

    const userMessage = inputText.trim();
    setInputText("");
    
    // 添加用户消息
    addAIMessage({ role: "user", content: userMessage });
    
    setIsLoading(true);
    try {
      // 构建消息历史
      const messages = [
        { role: "system", content: generateSystemPrompt() },
        ...state.aiMessages.slice(-10).map(m => ({ role: m.role, content: m.content })),
        { role: "user", content: userMessage },
      ];

      const response = await fetch(`${resolveBaseUrl(state.aiConfig.baseUrl || TOKENHUB_BASE_URL)}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${state.aiConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: state.aiConfig.model,
          messages,
          max_tokens: 1000,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const assistantMessage = data.choices[0]?.message?.content || "抱歉，我无法生成回复。";
        addAIMessage({ role: "assistant", content: assistantMessage });
      } else {
        const body = await response.text().catch(() => "");
        let message: string;
        try {
          message = JSON.parse(body)?.error?.message || body;
        } catch {
          message = body;
        }
        addAIMessage({
          role: "assistant",
          content: `请求失败：${describeFailure(response.status, message || response.statusText)}`,
        });
      }
    } catch (error) {
      addAIMessage({
        role: "assistant",
        content: `请求失败：${describeNetworkError(error instanceof Error ? error.message : "未知错误")}`,
      });
    } finally {
      setIsLoading(false);
    }
  };

  // 清除对话：Web 没有原生确认弹窗，直接执行并给可见反馈；真机保留确认
  const handleClearMessages = () => {
    if (Platform.OS === "web") {
      clearAIMessages();
      notify("成功 · 已清除", "对话记录已清空");
      return;
    }
    Alert.alert("清除对话", "确定要清除所有对话记录吗？", [
      { text: "取消", style: "cancel" },
      { text: "清除", style: "destructive", onPress: clearAIMessages },
    ]);
  };

  // 滚动到底部
  useEffect(() => {
    if (state.aiMessages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [state.aiMessages.length]);

  const markdownStyles = useMemo(() => ({
    body: { color: colors.foreground, fontSize: 15, lineHeight: 22 },
    paragraph: { marginTop: 0, marginBottom: 8 },
    code_inline: {
      backgroundColor: colors.surface,
      color: colors.foreground,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 6,
      fontFamily: "Menlo",
      fontSize: 14,
    },
    code_block: {
      backgroundColor: colors.surface,
      padding: 10,
      borderRadius: 8,
      fontFamily: "Menlo",
      fontSize: 13,
    },
    fence: {
      backgroundColor: colors.surface,
      padding: 10,
      borderRadius: 8,
      fontFamily: "Menlo",
      fontSize: 13,
    },
    bullet_list: { marginBottom: 8 },
    ordered_list: { marginBottom: 8 },
    blockquote: {
      borderLeftColor: colors.border,
      borderLeftWidth: 4,
      paddingLeft: 10,
      color: colors.muted,
    },
    link: { color: colors.primary },
  }), [colors]);

  const renderMessage = ({ item }: { item: AIMessage }) => (
    <View className={`mb-3 ${item.role === "user" ? "items-end" : "items-start"}`}>
      <View
        className={`max-w-[85%] rounded-2xl px-4 py-3 ${
          item.role === "user" ? "bg-primary" : "bg-surface border border-border"
        }`}
      >
        {item.role === "user" ? (
          <Text className="text-background">{item.content}</Text>
        ) : (
          <Markdown style={markdownStyles}>{item.content}</Markdown>
        )}
      </View>
      <Text className="text-muted text-xs mt-1 px-2">
        {new Date(item.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
      </Text>
    </View>
  );

  return (
    <ScreenContainer edges={["top", "left", "right", "bottom"]} className="flex-1">
      {/* 头部 */}
      <View className="flex-row items-center justify-between px-5 py-4 border-b border-border">
        <TouchableOpacity onPress={() => router.back()} className="p-1">
          <IconSymbol name="chevron.left" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <Text className="text-xl font-bold text-foreground">AI 助手</Text>
        <View className="flex-row gap-2">
          <TouchableOpacity onPress={() => setShowConfig(!showConfig)} className="p-1">
            <IconSymbol name="gearshape.fill" size={22} color={showConfig ? colors.primary : colors.muted} />
          </TouchableOpacity>
          {state.aiMessages.length > 0 && (
            <TouchableOpacity onPress={handleClearMessages} className="p-1">
              <IconSymbol name="trash" size={22} color={colors.muted} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* 常驻状态栏：不用展开配置面板也能点「测试连接」 */}
      <View className="flex-row items-center justify-between px-5 py-2 border-b border-border bg-surface">
        <View className="flex-row items-center flex-1 mr-3">
          <View
            className="w-2 h-2 rounded-full mr-2"
            style={{ backgroundColor: state.aiConfig.isConfigured ? "#22c55e" : "#f59e0b" }}
          />
          <Text className="text-muted text-xs" numberOfLines={1}>
            {state.aiConfig.isConfigured
              ? `已配置 · ${state.aiConfig.model || TOKENHUB_DEFAULT_MODEL} · ${Platform.OS === "web" ? "本机代理" : "直连"}`
              : "未配置 API Key"}
          </Text>
        </View>
        <TouchableOpacity
          onPress={handleTestConnection}
          disabled={isTesting}
          className="px-3 py-1.5 rounded-lg bg-primary"
          activeOpacity={0.7}
        >
          <Text className="text-background text-xs font-medium">
            {isTesting ? "测试中…" : "测试连接"}
          </Text>
        </TouchableOpacity>
      </View>

      {/* 结果条：所有操作反馈都在这里可见，Web 的 Alert.alert 是空函数 */}
      {notice && (
        <View
          className="mx-5 mt-3 rounded-xl px-4 py-3"
          style={{
            backgroundColor:
              notice.kind === "success"
                ? "rgba(34,197,94,0.12)"
                : notice.kind === "error"
                ? "rgba(239,68,68,0.12)"
                : colors.surface,
            borderColor:
              notice.kind === "success"
                ? "rgba(34,197,94,0.45)"
                : notice.kind === "error"
                ? "rgba(239,68,68,0.45)"
                : colors.border,
            borderWidth: 1,
          }}
        >
          <View className="flex-row items-start justify-between">
            <Text className="text-foreground font-semibold text-sm flex-1 mr-2">
              {notice.kind === "success" ? "✅ " : notice.kind === "error" ? "❌ " : "ℹ️ "}
              {notice.title}
            </Text>
            <TouchableOpacity onPress={() => setNotice(null)} activeOpacity={0.7}>
              <Text className="text-muted text-sm">✕</Text>
            </TouchableOpacity>
          </View>
          <Text className="text-foreground text-xs mt-2 leading-5">{notice.text}</Text>
        </View>
      )}

      {/* 配置面板 */}
      {showConfig && (
        <View className="px-5 py-4 border-b border-border bg-surface">
          <Text className="text-foreground font-semibold mb-1">智云 TokenHub</Text>
          <Text className="text-muted text-xs mb-1">
            {TOKENHUB_CONSOLE_URL} → 个人中心 → 账户管理 → 密钥管理，复制 API Key
          </Text>
          <Text className="text-muted text-xs mb-1">
            地址已内置；模型名 {TOKENHUB_DEFAULT_MODEL} 是教程图例，报「模型不存在」就点「查模型名」换成模型广场里的真实 ID。
          </Text>
          <Text className="text-muted text-xs mb-1">
            Key 只存本机加密区，不进备份、不上传；Web 预览只放内存，刷新要重新粘贴。
          </Text>
          <Text className="text-muted text-xs mb-4">
            Web 预览请用 npm run dev:web 启动（带本机代理）；手机 App 直连官方域名，不需要代理。
          </Text>

          {/* 高级设置：默认收起，日常不用碰 */}
          <TouchableOpacity
            onPress={() => setShowAdvanced(!showAdvanced)}
            className="mb-4"
            activeOpacity={0.7}
          >
            <Text className="text-muted text-sm">
              {showAdvanced ? "▾" : "▸"} 高级设置（服务商 / 地址 / 模型）
            </Text>
          </TouchableOpacity>

          {showAdvanced && (
            <>
          {/* Provider选择 */}
          <View className="mb-4">
            <Text className="text-muted text-sm mb-2">服务商</Text>
            <View className="flex-row flex-wrap gap-2">
              {PROVIDERS.map((p) => (
                <TouchableOpacity
                  key={p.value}
                  onPress={() => setProvider(p.value)}
                  className={`px-4 py-2 rounded-lg ${
                    provider === p.value ? "bg-primary" : "bg-background border border-border"
                  }`}
                  activeOpacity={0.7}
                >
                  <Text className={provider === p.value ? "text-background" : "text-foreground"}>
                    {p.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Base URL */}
          <View className="mb-4">
            <Text className="text-muted text-sm mb-2">API Base URL</Text>
            <TextInput
              value={baseUrl}
              onChangeText={setBaseUrl}
              placeholder="https://api.openai.com/v1"
              placeholderTextColor={colors.muted}
              className="bg-background rounded-xl px-4 py-3 text-foreground border border-border"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

            </>
          )}

          {/* API Key：默认隐藏，不能明文显示 */}
          <View className="mb-4">
            <Text className="text-muted text-sm mb-2">
              API Key {state.aiConfig.isConfigured ? "（已保存，留空表示不修改）" : ""}
            </Text>
            <View className="flex-row items-center gap-2">
              <TextInput
                value={apiKey}
                onChangeText={setApiKey}
                placeholder={state.aiConfig.isConfigured ? "粘贴新 Key 可替换" : "粘贴你的 API Key"}
                placeholderTextColor={colors.muted}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="password"
                className="flex-1 bg-background rounded-xl px-4 py-3 text-foreground border border-border"
              />
              <TouchableOpacity
                onPress={() => setApiKey("")}
                className="p-3 bg-background rounded-xl border border-border"
              >
                <IconSymbol name="trash" size={18} color={colors.muted} />
              </TouchableOpacity>
            </View>
          </View>

          {showAdvanced && (
            <>
          {/* Model */}
          <View className="mb-4">
            <Text className="text-muted text-sm mb-2">模型</Text>
            <TextInput
              value={model}
              onChangeText={setModel}
              placeholder="qwen3.7-max"
              placeholderTextColor={colors.muted}
              className="bg-background rounded-xl px-4 py-3 text-foreground border border-border"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity onPress={handleListModels} className="mt-2 self-start" activeOpacity={0.7}>
              <Text className="text-primary text-sm">查模型名（用当前 Key 拉 /v1/models）</Text>
            </TouchableOpacity>
            {modelList.length > 0 && (
              <View className="flex-row flex-wrap gap-2 mt-2">
                {modelList.map((id) => (
                  <TouchableOpacity
                    key={id}
                    onPress={() => setModel(id)}
                    className={`px-3 py-1 rounded-lg ${model === id ? "bg-primary" : "bg-background border border-border"}`}
                    activeOpacity={0.7}
                  >
                    <Text className={model === id ? "text-background text-xs" : "text-foreground text-xs"}>{id}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>

            </>
          )}

          {/* 操作按钮 */}
          <View className="flex-row gap-3">
            <TouchableOpacity
              onPress={handleTestConnection}
              disabled={isTesting}
              className="flex-1 bg-muted/20 rounded-xl py-3 items-center"
              activeOpacity={0.8}
            >
              {isTesting ? (
                <ActivityIndicator size="small" color={colors.foreground} />
              ) : (
                <Text className="text-foreground font-medium">测试连接</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSaveConfig}
              className="flex-1 bg-primary rounded-xl py-3 items-center"
              activeOpacity={0.8}
            >
              <Text className="text-background font-semibold">保存配置</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* 对话区域 */}
      <KeyboardAvoidingView 
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        className="flex-1"
        keyboardVerticalOffset={0}
      >
        {/* 消息列表 */}
        <FlatList
          ref={flatListRef}
          data={state.aiMessages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessage}
          contentContainerStyle={{ padding: 20, paddingBottom: 10 }}
          ListEmptyComponent={
            <View className="items-center py-10">
              <IconSymbol name="brain" size={48} color={colors.muted} />
              <Text className="text-muted mt-4 text-center">
                {state.aiConfig.isConfigured 
                  ? "开始和AI助手对话吧\n我可以帮你分析训练数据、提供建议"
                  : "请先配置API Key\n点击右上角齿轮图标"
                }
              </Text>
            </View>
          }
        />

        {/* 加载指示器 */}
        {isLoading && (
          <View className="px-5 pb-2">
            <View className="bg-surface rounded-2xl px-4 py-3 self-start border border-border">
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          </View>
        )}

        {/* 输入区域 */}
        <View className="px-5 py-3 border-t border-border bg-background">
          <View className="flex-row items-end gap-3">
            <TextInput
              value={inputText}
              onChangeText={setInputText}
              placeholder="输入消息..."
              placeholderTextColor={colors.muted}
              multiline
              maxLength={1000}
              className="flex-1 bg-surface rounded-2xl px-4 py-3 text-foreground border border-border max-h-32"
              style={{ minHeight: 44 }}
            />
            <TouchableOpacity
              onPress={handleSendMessage}
              disabled={!inputText.trim() || isLoading}
              className={`w-11 h-11 rounded-full items-center justify-center ${
                inputText.trim() && !isLoading ? "bg-primary" : "bg-muted/30"
              }`}
              activeOpacity={0.8}
            >
              <IconSymbol 
                name="paperplane.fill" 
                size={20} 
                color={inputText.trim() && !isLoading ? colors.background : colors.muted} 
              />
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}
