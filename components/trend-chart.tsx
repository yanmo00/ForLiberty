import { View, Text, useWindowDimensions } from "react-native";
import Svg, { Line, Path, Circle, Text as SvgText } from "react-native-svg";
import { useColors } from "@/hooks/use-colors";

export interface TrendPoint {
  /** X 轴标签（如日期 2026-11-20 或组次） */
  label: string;
  /** Y 轴数值 */
  value: number;
}

interface TrendChartProps {
  data: TrendPoint[];
  /** 折线/数据点颜色 */
  color?: string;
  /** 数值单位，显示在提示里 */
  unit?: string;
  /** 图表高度 */
  height?: number;
  /** 数值格式化（默认保留 1 位小数） */
  formatValue?: (value: number) => string;
}

/**
 * 轻量折线趋势图：用 react-native-svg 手绘，带网格线、Y 轴刻度、首尾 X 标签。
 * 主题色自动跟随当前明暗主题。数据不足 2 点时显示占位提示。
 */
export function TrendChart({
  data,
  color,
  unit,
  height = 180,
  formatValue,
}: TrendChartProps) {
  const colors = useColors();
  const { width: windowWidth } = useWindowDimensions();
  const lineColor = color ?? colors.primary;

  const valid = data.filter((p) => Number.isFinite(p.value));
  if (valid.length < 2) {
    return (
      <View className="rounded-xl bg-background border border-border items-center justify-center" style={{ height }}>
        <Text className="text-muted text-sm">至少需要 2 条记录才能显示趋势</Text>
      </View>
    );
  }

  // 画布宽度：比屏幕窄一点，避免贴边
  const width = Math.max(240, windowWidth - 80);
  const padLeft = 42;
  const padRight = 12;
  const padTop = 14;
  const padBottom = 26;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const values = valid.map((p) => p.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 1;
    max += 1;
  } else {
    const pad = (max - min) * 0.15;
    min -= pad;
    max += pad;
  }
  const range = max - min;

  const fmt = formatValue ?? ((v: number) => {
    const rounded = Math.round(v * 10) / 10;
    return String(rounded);
  });

  const points = valid.map((p, i) => {
    const x = padLeft + (valid.length === 1 ? plotW / 2 : (i / (valid.length - 1)) * plotW);
    const y = padTop + plotH - ((p.value - min) / range) * plotH;
    return { x, y, ...p };
  });

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const gridCount = 4;
  const gridLines = Array.from({ length: gridCount + 1 }, (_, i) => {
    const y = padTop + (i / gridCount) * plotH;
    const value = max - (i / gridCount) * range;
    return { y, label: fmt(value) };
  });

  // X 轴最多显示 4 个标签，均匀取样，避免重叠
  const xLabelCount = Math.min(4, valid.length);
  const xLabelIndexes = Array.from({ length: xLabelCount }, (_, i) =>
    xLabelCount === 1 ? 0 : Math.round((i / (xLabelCount - 1)) * (valid.length - 1))
  );

  return (
    <View className="rounded-xl bg-background border border-border" style={{ height, width: "100%" }}>
      <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {/* 水平网格线 + Y 轴刻度 */}
        {gridLines.map((g, i) => (
          <Line
            key={`grid-${i}`}
            x1={padLeft}
            y1={g.y}
            x2={width - padRight}
            y2={g.y}
            stroke={colors.border}
            strokeWidth={1}
          />
        ))}
        {gridLines.map((g, i) => (
          <SvgText
            key={`ylabel-${i}`}
            x={padLeft - 6}
            y={g.y + 3}
            fontSize={10}
            fill={colors.muted}
            textAnchor="end"
          >
            {g.label}
          </SvgText>
        ))}

        {/* 折线 */}
        <Path d={linePath} fill="none" stroke={lineColor} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />

        {/* 数据点：最后一个高亮 */}
        {points.map((p, i) => (
          <Circle
            key={`dot-${i}`}
            cx={p.x}
            cy={p.y}
            r={i === points.length - 1 ? 4.5 : 3}
            fill={i === points.length - 1 ? lineColor : colors.surface}
            stroke={lineColor}
            strokeWidth={2}
          />
        ))}

        {/* X 轴标签 */}
        {xLabelIndexes.map((idx, i) => (
          <SvgText
            key={`xlabel-${i}`}
            x={points[idx].x}
            y={height - 8}
            fontSize={10}
            fill={colors.muted}
            textAnchor="middle"
          >
            {points[idx].label}
          </SvgText>
        ))}
      </Svg>
    </View>
  );
}
