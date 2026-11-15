import { View, KeyboardAvoidingView, Platform, type ViewProps } from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";

import { cn } from "@/lib/utils";
import { useKeyboardOverlap } from "@/hooks/use-keyboard-overlap";

export interface ScreenContainerProps extends ViewProps {
  /**
   * SafeArea edges to apply. Defaults to ["top", "left", "right"].
   * Bottom is typically handled by Tab Bar.
   */
  edges?: Edge[];
  /**
   * Tailwind className for the content area.
   */
  className?: string;
  /**
   * Additional className for the outer container (background layer).
   */
  containerClassName?: string;
  /**
   * Additional className for the SafeAreaView (content layer).
   */
  safeAreaClassName?: string;
  /**
   * 是否自动为软键盘让位（默认开启）。页面自己已有 KeyboardAvoidingView 时传 false，
   * 避免两层规避叠加把内容顶飞。AI 对话界面就是这种情况。
   */
  keyboardAware?: boolean;
  /** iOS 的 keyboardVerticalOffset，用于补偿头部/导航栏高度。 */
  keyboardVerticalOffset?: number;
}

/**
 * 全 App 共用的页面容器：SafeArea + 背景 + 软键盘自适应。
 *
 * 键盘弹出时：
 * - iOS：保留 KeyboardAvoidingView（padding），兼容头部偏移；
 * - Android / Web：给最外层容器补 paddingBottom = 实测「键盘盖住内容的高度」。
 *   Android SDK54 edge-to-edge 下窗口不 resize，KAV 会失效，只能这样手动补；
 *   系统已自行 resize 时实测高度是 0，不会双重避让。
 * - 键盘收起：padding 归 0，布局自动恢复，不留空白。
 * 因此所有用这个容器的表单页（饮食记录、体测、动作库、计划编辑、设置、AI 对话等）
 * 输入框都会跟着键盘上移，不需要每个页面各写一遍监听，也不允许页面自己再套一层 KAV。
 */
export function ScreenContainer({
  children,
  edges = ["top", "left", "right"],
  className,
  containerClassName,
  safeAreaClassName,
  style,
  keyboardAware = true,
  keyboardVerticalOffset = 0,
  ...props
}: ScreenContainerProps) {
  const { height, visible } = useKeyboardOverlap();
  // iOS 用 KAV（浏览器和 Android 都不用它），其余平台统一用实测覆盖高度补 paddingBottom。
  const useKav = keyboardAware && Platform.OS === "ios";
  const bottomInset = keyboardAware && !useKav && visible ? height : 0;

  const content = (
    <SafeAreaView
      edges={edges}
      className={cn("flex-1", safeAreaClassName)}
      style={style}
    >
      <View className={cn("flex-1", className)}>{children}</View>
    </SafeAreaView>
  );

  return (
    <View
      className={cn("flex-1", "bg-background", containerClassName)}
      style={bottomInset ? ({ paddingBottom: bottomInset } as any) : undefined}
      {...props}
    >
      {useKav ? (
        <KeyboardAvoidingView
          behavior="padding"
          keyboardVerticalOffset={keyboardVerticalOffset}
          style={{ flex: 1 }}
        >
          {content}
        </KeyboardAvoidingView>
      ) : (
        content
      )}
    </View>
  );
}
