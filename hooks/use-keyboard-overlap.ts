import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/**
 * 统一的软键盘占位高度：所有页面共用一套判断，避免每个界面各写一份监听。
 * - 原生：Keyboard 事件给键盘真实高度。
 * - Web：没有 RN 键盘事件，用 visualViewport 被挤掉的高度推断（>80px 才算键盘，
 *   否则浏览器缩放/地址栏收起也会误判）。
 * 返回 0 表示键盘收起，布局随即恢复原状。
 */
export function useKeyboardOverlap(): { height: number; visible: boolean } {
  const [height, setHeight] = useState(0);
  const [visible, setVisible] = useState(false);

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
        setHeight(shown ? overlap : 0);
        setVisible(shown);
      };
      onResize();
      vv.addEventListener?.("resize", onResize);
      vv.addEventListener?.("scroll", onResize);
      return () => {
        vv.removeEventListener?.("resize", onResize);
        vv.removeEventListener?.("scroll", onResize);
      };
    }

    const show = Keyboard.addListener("keyboardDidShow", (e) => {
      setHeight(e.endCoordinates.height);
      setVisible(true);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      setHeight(0);
      setVisible(false);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return { height, visible };
}
