// 饮食记录的唯一「字段补全 + 归一化」入口。
// AI 工具调用和手工录入都必须经过这里：模型经常只给食物名和热量，
// 以前缺的蛋白/碳水/脂肪/份量单位/餐次/食物库 ID 会被写成 0 或 undefined，
// 落库就成了残缺记录。这里统一按食物库每 100g 数据折算并补齐所有字段。
import type { MealType, NutritionLogItem } from "./types";
import { MEAL_TYPE_NAMES } from "./types";

export interface FoodReference {
  id: string;
  name: string;
  caloriesPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatsPer100g: number;
  isCustom?: boolean;
}

export interface NutritionLogDraft {
  date?: string;
  name?: string;
  foodId?: string;
  quantity?: number | string;
  unit?: string;
  calories?: number | string;
  carbs?: number | string;
  protein?: number | string;
  fats?: number | string;
  source?: string;
  mealType?: string;
  notes?: string;
}

export type NormalizedNutritionLog = Omit<NutritionLogItem, "id" | "loggedAt">;

const MEAL_VALUES: string[] = ["breakfast", "lunch", "dinner", "snack"];
const UNIT_VALUES: string[] = ["g", "ml", "serving"];
const SOURCE_VALUES: string[] = ["database", "custom", "quick"];

/** 没指定餐次时按当前钟点推断，保证每条记录都有归属餐次。 */
export function inferMealType(hour: number = new Date().getHours()): MealType {
  if (hour < 10) return "breakfast";
  if (hour < 15) return "lunch";
  if (hour < 21) return "dinner";
  return "snack";
}

function todayString(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function num(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

function findFood(name: string, foods: FoodReference[]): FoodReference | undefined {
  const key = name.toLowerCase();
  if (!key) return undefined;
  return (
    foods.find((f) => f.name.toLowerCase() === key) ||
    foods.find((f) => key.includes(f.name.toLowerCase()) || f.name.toLowerCase().includes(key))
  );
}

/**
 * 返回可直接落库的完整记录；食物名为空时返回 null（调用方应拒绝这次记录）。
 * - 份量/单位：非法或缺省按 100g（serving 按 1 份）兜底
 * - 宏量：AI 没给或给 0 时，按食物库每 100g × 份量折算；库里也没有才记 0
 * - foodId / source：按名称匹配食物库自动补齐
 * - mealType：合法值优先，其次调用方给的兜底，最后按钟点推断
 */
export function normalizeNutritionLogInput(
  draft: NutritionLogDraft,
  foods: FoodReference[] = [],
  fallbackMealType?: MealType
): { date: string; item: NormalizedNutritionLog } | null {
  const name = String(draft.name ?? "").trim();
  if (!name) return null;

  const unit: NormalizedNutritionLog["unit"] = UNIT_VALUES.includes(String(draft.unit ?? ""))
    ? (draft.unit as NormalizedNutritionLog["unit"])
    : "g";
  const givenQty = num(draft.quantity);
  const quantity = givenQty && givenQty > 0 ? givenQty : unit === "serving" ? 1 : 100;
  const scale = unit === "serving" ? quantity : quantity / 100;

  const matched = findFood(name, foods);
  const foodId = draft.foodId || matched?.id;
  const source: NormalizedNutritionLog["source"] = SOURCE_VALUES.includes(String(draft.source ?? ""))
    ? (draft.source as NormalizedNutritionLog["source"])
    : matched
    ? matched.isCustom
      ? "custom"
      : "database"
    : "quick";

  const fill = (given: unknown, per100g: number | undefined): number => {
    const n = num(given);
    if (n !== undefined && n > 0) return r1(n);
    if (per100g !== undefined && per100g > 0) return r1(per100g * scale);
    return n !== undefined ? r1(n) : 0;
  };

  const item: NormalizedNutritionLog = {
    foodId,
    name,
    quantity,
    unit,
    calories: fill(draft.calories, matched?.caloriesPer100g),
    carbs: fill(draft.carbs, matched?.carbsPer100g),
    protein: fill(draft.protein, matched?.proteinPer100g),
    fats: fill(draft.fats, matched?.fatsPer100g),
    source,
    mealType: MEAL_VALUES.includes(String(draft.mealType ?? ""))
      ? (draft.mealType as MealType)
      : fallbackMealType ?? inferMealType(),
    notes:
      typeof draft.notes === "string" && draft.notes.trim()
        ? draft.notes.trim().slice(0, 200)
        : undefined,
  };

  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(draft.date ?? "")) ? String(draft.date) : todayString(),
    item,
  };
}

/** AI 工具执行结果里回显全部字段，便于用户当场核对记录是否完整。 */
export function summarizeNutritionLogItem(item: NormalizedNutritionLog | NutritionLogItem): string {
  const meal = item.mealType ? `｜${MEAL_TYPE_NAMES[item.mealType]}` : "";
  return `${item.name} ${item.quantity}${item.unit}｜${item.calories}kcal｜蛋白 ${item.protein}g／碳水 ${item.carbs}g／脂肪 ${item.fats}g｜来源 ${item.source}${meal}`;
}
