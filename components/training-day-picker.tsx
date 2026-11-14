import { useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { useColors } from "@/hooks/use-colors";
import { getTodayString } from "@/lib/storage";
import {
  getTemplateCurrentDayNumber,
  getTemplateTrainingDayCount,
  resetTemplateDayOffset,
  setTemplateCurrentDay,
} from "@/lib/training-plan";
import type { WorkoutTemplate } from "@/lib/types";

type Props = {
  template: WorkoutTemplate;
  onUpdate: (next: WorkoutTemplate) => Promise<void> | void;
};

/** 随时把「当前第几天训练」改到任意一天；改完按自然日继续自动推进。 */
export function TrainingDayPicker({ template, onUpdate }: Props) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);

  const date = getTodayString();
  const count = getTemplateTrainingDayCount(template);
  const current = getTemplateCurrentDayNumber(template, date); // 0 = 休息日
  const hasOffset = Number(template.schedule?.dayOffset ?? 0) !== 0;
  const sortedDays = [...template.days].sort((a, b) => a.dayIndex - b.dayIndex);

  const apply = async (build: () => WorkoutTemplate) => {
    if (busy) return;
    setBusy(true);
    try {
      await onUpdate(build());
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <TouchableOpacity
        onPress={() => setExpanded((v) => !v)}
        activeOpacity={0.7}
        style={{
          flexDirection: "row",
          alignItems: "center",
          alignSelf: "flex-start",
          paddingHorizontal: 12,
          paddingVertical: 7,
          borderRadius: 999,
          backgroundColor: colors.primary + "1A",
          borderWidth: 1,
          borderColor: colors.primary + "55",
        }}
      >
        <Text style={{ color: colors.primary, fontSize: 13, fontWeight: "600" }}>
          {current === 0 ? "今天休息" : `第 ${current} 天训练`} · {expanded ? "收起" : "改天"}
        </Text>
      </TouchableOpacity>

      {expanded && (
        <View style={{ marginTop: 10 }}>
          <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 18, marginBottom: 10 }}>
            点一下把今天设成第 N 天，之后每天自动往后顺延；「开始今日训练」会跟着变。
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {Array.from({ length: count }, (_, i) => i + 1).map((n) => {
              const selected = n === current;
              return (
                <TouchableOpacity
                  key={n}
                  disabled={busy}
                  onPress={() => apply(() => setTemplateCurrentDay(template, date, n))}
                  activeOpacity={0.7}
                  style={{
                    minWidth: 74,
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    borderRadius: 10,
                    backgroundColor: selected ? colors.primary : colors.surface,
                    borderWidth: 1,
                    borderColor: selected ? colors.primary : colors.border,
                  }}
                >
                  <Text
                    style={{
                      color: selected ? colors.background : colors.foreground,
                      fontSize: 13,
                      fontWeight: "600",
                    }}
                  >
                    第 {n} 天
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={{
                      color: selected ? colors.background : colors.muted,
                      fontSize: 11,
                      marginTop: 2,
                      maxWidth: 110,
                    }}
                  >
                    {sortedDays[n - 1]?.name || ""}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {hasOffset && (
            <TouchableOpacity
              onPress={() => apply(() => resetTemplateDayOffset(template, date))}
              disabled={busy}
              activeOpacity={0.7}
              style={{ alignSelf: "flex-start", marginTop: 10 }}
            >
              <Text style={{ color: colors.muted, fontSize: 12, textDecorationLine: "underline" }}>
                恢复按日期自动推算
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}
