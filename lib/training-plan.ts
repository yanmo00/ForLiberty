import type { WorkoutTemplate, TemplateDay } from "./types";

// 保持纯计算模块：不依赖 storage（那边会拉 AsyncStorage），也方便直接跑逻辑验证。
// 与 storage.todayString() 同口径：UTC 日期 YYYY-MM-DD。
function todayString(): string {
  return new Date().toISOString().split("T")[0];
}

function toUtcDate(dateString: string): Date {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(Date.UTC(year, (month || 1) - 1, day || 1));
}

function diffInDays(start: string, end: string): number {
  const startDate = toUtcDate(start);
  const endDate = toUtcDate(end);
  const diffMs = endDate.getTime() - startDate.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

export function getTemplateCycleLength(template: WorkoutTemplate): number {
  const trainingDays = getTemplateTrainingDayCount(template);
  const restDays = template.schedule?.restDaysBetweenCycles ?? 0;
  return Math.max(1, trainingDays + Math.max(0, restDays));
}

export function getTemplateStartDate(template: WorkoutTemplate): string {
  return template.schedule?.startDate || template.createdAt || todayString();
}

// 计划里有几个训练日（选择器列 1..N）
export function getTemplateTrainingDayCount(template: WorkoutTemplate): number {
  return Math.max(
    1,
    Math.min(template.schedule?.trainingDaysPerWeek ?? template.days.length, template.days.length)
  );
}

// 统一的周期位置（0-based）。dayOffset 是手动切天留下的偏移，
// 只改一次起点，之后仍按自然日自动 +1 推进。
function getCycleDay(template: WorkoutTemplate, date: string): number {
  const cycleLength = getTemplateCycleLength(template);
  const offset = Number(template.schedule?.dayOffset ?? 0) || 0;
  const daysSince = diffInDays(getTemplateStartDate(template), date) + offset;
  return ((daysSince % cycleLength) + cycleLength) % cycleLength;
}

// 当前处于第几个训练日（1-based）；休息日返回 0
export function getTemplateCurrentDayNumber(template: WorkoutTemplate, date: string): number {
  const cycleDay = getCycleDay(template, date);
  const trainingDays = getTemplateTrainingDayCount(template);
  return cycleDay < trainingDays ? cycleDay + 1 : 0;
}

export function getPlanForDate(template: WorkoutTemplate, date: string) {
  const cycleDay = getCycleDay(template, date);
  const trainingDays = getTemplateTrainingDayCount(template);

  if (cycleDay >= trainingDays) {
    return {
      isRestDay: true,
      cycleDay,
      dayIndex: undefined,
      day: undefined,
    };
  }

  const sortedDays = [...template.days].sort((a, b) => a.dayIndex - b.dayIndex);
  const day = sortedDays[cycleDay] || sortedDays[0];
  return {
    isRestDay: false,
    cycleDay,
    dayIndex: day?.dayIndex,
    day: day as TemplateDay | undefined,
  };
}

export function getNextWorkoutDate(template: WorkoutTemplate, fromDate: string): string {
  const cycleLength = getTemplateCycleLength(template);
  const trainingDays = getTemplateTrainingDayCount(template);
  const cycleDay = getCycleDay(template, fromDate);

  if (cycleDay < trainingDays) {
    return fromDate;
  }

  const daysUntilNext = cycleLength - cycleDay;
  const nextDate = toUtcDate(fromDate);
  nextDate.setUTCDate(nextDate.getUTCDate() + daysUntilNext);
  return nextDate.toISOString().split("T")[0];
}

// 把 date 这天手动设成第 dayNumber 个训练日（1-based），返回可直接落库的新模板。
export function setTemplateCurrentDay(
  template: WorkoutTemplate,
  date: string,
  dayNumber: number
): WorkoutTemplate {
  const count = getTemplateTrainingDayCount(template);
  const target = Math.max(1, Math.min(Math.round(dayNumber), count)) - 1;
  const delta = target - getCycleDay(template, date);
  const base = Number(template.schedule?.dayOffset ?? 0) || 0;
  // 预设模板常缺 startDate，此时推算锚点会 fallback 成「今天」，导致周期永远不推进。
  // 借这次手动改天把锚点固定下来，之后才能按自然日自动 +1。
  const startDate = template.schedule?.startDate || template.createdAt || date;
  return {
    ...template,
    schedule: { ...template.schedule, startDate, dayOffset: base + delta },
    updatedAt: new Date().toISOString(),
  };
}

// 恢复「按开始日期自动推算」
export function resetTemplateDayOffset(template: WorkoutTemplate, date: string = todayString()): WorkoutTemplate {
  return {
    ...template,
    schedule: {
      ...template.schedule,
      startDate: template.schedule?.startDate || template.createdAt || date,
      dayOffset: 0,
    },
    updatedAt: new Date().toISOString(),
  };
}
