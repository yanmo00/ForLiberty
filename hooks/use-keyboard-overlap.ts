import { useEffect, useState } from "react";
import { Dimensions, Keyboard, Platform } from "react-native";

type OverlapState = {
  /** 还需要手动补的高度（paddingBottom）。0 表示系统已经自己让位，不要再补。 */
  height: number;
  visible: boolean;
  /** 键盘真实高度，给页面算「可用高度」用（例如配置面板限高）。 */
  keyboardHeight: number;
};

/**
 * 统一软键盘占位：所有页面共用一套判断，避免每个界面各写一份监听。
 *
 * - Web：没有 RN 键盘事件，用 visualViewport 被挤掉的高度推断（>80px 才算键盘，
 *   否则浏览器缩放/地址栏收起也会误判）。
 * - Android（关键点）：SDK54 全面屏 / edge-to-edge 下系统可能不再 resize 窗口，
 *   KeyboardAvoidingView 拿不到正确高度，输入框就会一直被键盘盖住。
 *   用 endCoordinates.screenY 与当前窗口高度算出「键盘盖住了多少内容」：
 *   系统已 resize → 差值≈0，不补（否则双重避让把输入区顶飞）；
 *   系统没 resize → 差值≈键盘高，手动补一段 paddingBottom。
 * - iOS：系统不 resize，差值≈键盘高，容器同样补 paddingBottom / KAV padding。
 *
 * 键盘收起时 height 归 0，布局自动恢复，不留空白。
 */
export function useKeyboardOverlap(): OverlapState {
  const [state, setState] = useState<OverlapState>({
    height: 0,
    visible: false,
    keyboardHeight: 0,
  });

  useEffect(() => {
    if (Platform.OS === "web") {
      const vv = (globalThis as any).visualViewport;
      if (!vv) return;
      const onResize = () => {
        const overlap = Math.max(
          0,
          (globalThis as any).innerHeight - vv.height - vv.offsetTop
        );
        const shown = overlap > 80;
        setState({
          height: shown ? overlap : 0,
          visible: shown,
          keyboardHeight: shown ? overlap : 0,
        });
      };
      onResize();
      vv.addEventListener?.("resize", onResize);
      vv.addEventListener?.("scroll", onResize);
      return () => {
        vv.removeEventListener?.("resize", onResize);
        vv.removeEventListener?.("scroll", onResize);
      };
    }

    let last = { screenY: 0, height: 0, shown: false };
    const recompute = () => {
      if (!last.shown) {
        setState({ height: 0, visible: false, keyboardHeight: 0 });
        return;
      }
      const winH = Dimensions.get("window").height;
      // 拿不到 screenY 时按「窗口完全没被压缩」处理，保守补齐整个键盘高度。
      const keyboardTop = last.screenY || winH - last.height;
      const uncovered = winH - keyboardTop;
      // 差值很小说明系统已经自己压缩了窗口（adjustResize 生效），再补就是双重避让。
      // 差值明显说明键盘盖在内容上，直接补齐整个键盘高度，避免状态栏坐标基准差导致少补几十 px。
      const height = uncovered > 80 ? last.height : 0;
      setState({ height, visible: true, keyboardHeight: last.height });
    };

    const show = Keyboard.addListener("keyboardDidShow", (e) => {
      last = {
        screenY: e.endCoordinates.screenY ?? 0,
        height: e.endCoordinates.height,
        shown: true,
      };
      recompute();
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      last = { screenY: 0, height: 0, shown: false };
      recompute();
    });
    // 窗口尺寸变化（键盘动画结束、分屏、旋转）后重算一次，避免拿到动画中间态。
    const dims = Dimensions.addEventListener?.("change", recompute);
    return () => {
      show.remove();
      hide.remove();
      dims?.remove?.();
    };
  }, []);

  return state;
}
