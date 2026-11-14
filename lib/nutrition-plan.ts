// 自定义营养方案的纯计算层：不依赖 AsyncStorage / React，方便单独跑逻辑验证。
// 「饮食 → 营养建议 → 自定义」和 AI 助手共用这里的数据结构与解析规则。
import type { CustomNutritionPlan } from "./types";

export type NutritionPlanValues = Pick<
  CustomNutritionPlan,
  "calories" | "protein" | "carbs" | "fats"
>;

export type ParsedNutritionPlan = Partial<NutritionPlanValues>;

function firstNumber(text: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/**
 * 从 AI 的中文/Markdown 回复里抽取营养参数。
 * 兼容 "2200 kcal"、"热量：2200"、"| 蛋白质 | 150 g |" 等写法。
 * 只有同时拿到热量与至少两项宏量才认为解析成功，避免把零散数字当成方案。
 */
export function parseNutritionPlanFromText(text: string): ParsedNutritionPlan | null {
  if (!text) return null;
  // 去掉 Markdown 强调符，保留数字与中文；全角冒号统一成半角不必要，正则里已覆盖
  const flat = text.replace(/\*+/g, "").replace(/[,，]/g, " ");

  const calories = firstNumber(flat, [
    /(\d{3,4}(?:\.\d+)?)\s*(?:kcal|大卡|千卡|卡路里)/i,
    /(?:热量|能量|卡路里|kcal)\D{0,8}(\d{3,4}(?:\.\d+)?)/i,
  ]);
  const protein = firstNumber(flat, [
    /(?:蛋白质|蛋白|protein)\D{0,6}(\d{1,3}(?:\.\d+)?)/i,
  ]);
  const carbs = firstNumber(flat, [
    /(?:碳水化合物|碳水|糖类|carbs?)\D{0,6}(\d{1,3}(?:\.\d+)?)/i,
  ]);
  const fats = firstNumber(flat, [
    /(?:脂肪|油脂|fats?)\D{0,6}(\d{1,3}(?:\.\d+)?)/i,
  ]);

  const macros = [protein, carbs, fats].filter((v) => v !== undefined).length;
  if (calories === undefined || macros < 2) return null;

  const result: ParsedNutritionPlan = { calories };
  if (protein !== undefined) result.protein = protein;
  if (carbs !== undefined) result.carbs = carbs;
  if (fats !== undefined) result.fats = fats;
  return result;
}

export function buildCustomNutritionPlan(
  values: NutritionPlanValues,
  source: "ai" | "manual",
  note?: string
): CustomNutritionPlan {
  return {
    calories: Math.max(0, Math.round(values.calories)),
    protein: Math.max(0, Math.round(values.protein)),
    carbs: Math.max(0, Math.round(values.carbs)),
    fats: Math.max(0, Math.round(values.fats)),
    note,
    source,
    updatedAt: new Date().toISOString(),
    enabled: true,
  };
}

export function formatPlanSummary(plan: NutritionPlanValues | CustomNutritionPlan): string {
  return `热量 ${plan.calories} kcal · 蛋白 ${plan.protein}g · 碳水 ${plan.carbs}g · 脂肪 ${plan.fats}g`;
}

/** 三大宏量供能占比，仅用于界面展示。 */
export function macroPercentages(plan: NutritionPlanValues): {
  protein: number;
  carbs: number;
  fats: number;
} {
  const total = plan.calories || 1;
  return {
    protein: Math.round((plan.protein * 4 / total) * 100),
    carbs: Math.round((plan.carbs * 4 / total) * 100),
    fats: Math.round((plan.fats * 9 / total) * 100),
  };
}
