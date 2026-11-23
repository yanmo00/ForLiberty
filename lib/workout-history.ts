import type { WorkoutSession, WorkoutSet } from "./types";

/**
 * 找出某动作最近一次训练的记录（按日期 + 开始时间倒序）。
 * workoutSessions 通常是「旧的在前、新的在后」，但这里不依赖数组顺序，
 * 显式按日期/时间排序，避免导入数据后顺序错乱。
 */
export function getLastSessionForExercise(
  sessions: WorkoutSession[],
  exerciseId: string
): WorkoutSession | null {
  const candidates = sessions.filter((s) =>
    s.sets.some((set) => set.exerciseId === exerciseId)
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const byDate = b.date.localeCompare(a.date);
    if (byDate !== 0) return byDate;
    return (b.startTime ?? "").localeCompare(a.startTime ?? "");
  });
  return candidates[0];
}

/**
 * 取某动作「最近一次训练」的正式组（排除热身），按组序升序。
 */
export function getLastSetsForExercise(
  sessions: WorkoutSession[],
  exerciseId: string
): WorkoutSet[] {
  const last = getLastSessionForExercise(sessions, exerciseId);
  if (!last) return [];
  return last.sets
    .filter((s) => s.exerciseId === exerciseId && !s.isWarmup)
    .sort((a, b) => a.setIndex - b.setIndex);
}

/**
 * 某动作的重量趋势：每个训练日取当天该动作正式组的最大重量，
 * 按日期升序返回，供折线图使用。空数据返回 []。
 */
export function getExerciseWeightSeries(
  sessions: WorkoutSession[],
  exerciseId: string
): { label: string; value: number; date: string }[] {
  const byDate = new Map<string, number>();
  for (const session of sessions) {
    const weights = session.sets
      .filter((s) => s.exerciseId === exerciseId && !s.isWarmup && Number.isFinite(s.weight) && s.weight > 0)
      .map((s) => s.weight);
    if (weights.length === 0) continue;
    const max = Math.max(...weights);
    const prev = byDate.get(session.date);
    if (prev === undefined || max > prev) byDate.set(session.date, max);
  }
  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, value]) => ({
      date,
      label: date.slice(5).replace("-", "/"),
      value,
    }));
}

/** 有训练历史的动作 id 列表（按最近一次训练时间倒序） */
export function getExercisesWithHistory(sessions: WorkoutSession[]): string[] {
  const latest = new Map<string, { date: string; startTime: string }>();
  for (const session of sessions) {
    for (const set of session.sets) {
      const prev = latest.get(set.exerciseId);
      const cur = { date: session.date, startTime: session.startTime ?? "" };
      if (
        !prev ||
        cur.date > prev.date ||
        (cur.date === prev.date && cur.startTime > prev.startTime)
      ) {
        latest.set(set.exerciseId, cur);
      }
    }
  }
  return [...latest.entries()]
    .sort((a, b) => {
      const byDate = b[1].date.localeCompare(a[1].date);
      return byDate !== 0 ? byDate : b[1].startTime.localeCompare(a[1].startTime);
    })
    .map(([id]) => id);
}
