import { useState } from "react";
import { ScrollView, Text, View, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { ScreenContainer } from "@/components/screen-container";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { TrendChart, type TrendPoint } from "@/components/trend-chart";
import { useColors } from "@/hooks/use-colors";
import { useApp } from "@/lib/app-context";
import {
  getExercisesWithHistory,
  getExerciseWeightSeries,
  getLastSetsForExercise,
} from "@/lib/workout-history";
import { MUSCLE_GROUP_NAMES } from "@/lib/types";

export default function TrendsScreen() {
  const colors = useColors();
  const router = useRouter();
  const { state } = useApp();

  const historyIds = getExercisesWithHistory(state.workoutSessions);
  const [selectedId, setSelectedId] = useState<string | null>(historyIds[0] ?? null);
  const activeId = selectedId && historyIds.includes(selectedId) ? selectedId : historyIds[0] ?? null;

  const selectedExercise = activeId ? state.exercises.find((e) => e.id === activeId) : null;
  const series: TrendPoint[] = activeId ? getExerciseWeightSeries(state.workoutSessions, activeId) : [];
  const lastSets = activeId ? getLastSetsForExercise(state.workoutSessions, activeId) : [];
  const maxWeight = series.length > 0 ? Math.max(...series.map((p) => p.value)) : 0;
  const latestWeight = series.length > 0 ? series[series.length - 1].value : 0;

  return (
    <ScreenContainer className="flex-1">
      <View className="flex-row items-center px-5 py-4 border-b border-border">
        <TouchableOpacity onPress={() => router.back()} className="p-1 mr-3">
          <IconSymbol name="chevron.left" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <Text className="text-xl font-bold text-foreground">重量趋势</Text>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 100 }}
        showsVerticalScrollIndicator={false}
      >
        {historyIds.length === 0 ? (
          <View className="items-center py-20 px-5">
            <IconSymbol name="chart.line.uptrend.xyaxis" size={48} color={colors.muted} />
            <Text className="text-muted mt-4 text-center">
              暂无训练记录{"\n"}完成训练后即可查看各动作的重量趋势
            </Text>
          </View>
        ) : (
          <>
            {/* 动作选择 */}
            <View className="px-5 py-4">
              <Text className="text-foreground font-semibold mb-3">选择动作</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View className="flex-row gap-2">
                  {historyIds.map((id) => {
                    const ex = state.exercises.find((e) => e.id === id);
                    const active = id === activeId;
                    return (
                      <TouchableOpacity
                        key={id}
                        onPress={() => setSelectedId(id)}
                        className={`px-4 py-2 rounded-full border ${active ? "bg-primary border-primary" : "bg-surface border-border"}`}
                        activeOpacity={0.7}
                      >
                        <Text className={active ? "text-background font-medium" : "text-foreground"}>
                          {ex?.name ?? "未知动作"}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </ScrollView>
            </View>

            {/* 趋势图 */}
            {selectedExercise && (
              <View className="px-5">
                <View className="mb-3">
                  <Text className="text-foreground font-semibold">
                    {selectedExercise.name} · 重量趋势
                  </Text>
                  <Text className="text-muted text-sm">
                    {MUSCLE_GROUP_NAMES[selectedExercise.muscleGroup]} · 每个训练日取最高重量
                  </Text>
                </View>

                <TrendChart data={series} color={colors.primary} unit="kg" height={200} />

                {/* 数据摘要 */}
                <View className="flex-row gap-3 mt-4">
                  <View className="flex-1 bg-surface rounded-xl p-4 border border-border items-center">
                    <Text className="text-foreground font-bold text-xl">{latestWeight}</Text>
                    <Text className="text-muted text-xs mt-1">最近 (kg)</Text>
                  </View>
                  <View className="flex-1 bg-surface rounded-xl p-4 border border-border items-center">
                    <Text className="text-foreground font-bold text-xl">{maxWeight}</Text>
                    <Text className="text-muted text-xs mt-1">最高 (kg)</Text>
                  </View>
                  <View className="flex-1 bg-surface rounded-xl p-4 border border-border items-center">
                    <Text className="text-foreground font-bold text-xl">{series.length}</Text>
                    <Text className="text-muted text-xs mt-1">训练次数</Text>
                  </View>
                </View>

                {lastSets.length > 0 && (
                  <View className="bg-surface rounded-xl p-4 border border-border mt-3">
                    <Text className="text-foreground font-semibold mb-2">上次训练明细</Text>
                    {lastSets.map((set, i) => (
                      <View key={set.id} className="flex-row justify-between py-1">
                        <Text className="text-muted">第 {i + 1} 组</Text>
                        <Text className="text-foreground">{set.weight} kg × {set.reps}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </ScreenContainer>
  );
}
