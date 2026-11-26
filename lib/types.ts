// 核心数据类型定义

// 肌肉群分类
export type MuscleGroup = 'chest' | 'back' | 'shoulders' | 'arms' | 'legs' | 'core';

// 器械类型
export type Equipment = 'barbell' | 'dumbbell' | 'cable' | 'machine' | 'bodyweight' | 'kettlebell' | 'bands' | 'other';

// 单位
export type WeightUnit = 'kg' | 'lb';

// 动作定义
export interface Exercise {
  id: string;
  name: string;
  muscleGroup: MuscleGroup;
  equipment: Equipment;
  description?: string;
  isCustom?: boolean;
  defaultSets?: number;
  defaultReps?: number;
  defaultWeight?: number;
}

// 训练组
export interface WorkoutSet {
  id: string;
  exerciseId: string;
  setIndex: number;
  isWarmup: boolean;
  weight: number;
  reps: number;
  restSeconds?: number;
  completedAt?: string;
}

// 训练会话
export interface WorkoutSession {
  id: string;
  templateId?: string;
  templateName?: string;
  date: string;
  startTime: string;
  endTime?: string;
  notes?: string;
  sets: WorkoutSet[];
  durationSeconds?: number;
  plan?: WorkoutSessionPlan;
}

// 模板动作配置
export interface TemplateExercise {
  id: string;
  exerciseId: string;
  // 模板内自定义显示名；留空则用动作库里的原名。改这里不会改动动作库。
  name?: string;
  order: number;
  sets: number;
  reps: number;
  weight?: number;
  restSeconds?: number;
  notes?: string;
}

// 训练模板中的一天
export interface TemplateDay {
  dayIndex: number;
  name: string;
  muscleGroups: MuscleGroup[];
  exercises: TemplateExercise[];
}

export interface TemplateSchedule {
  trainingDaysPerWeek: number;
  restDaysBetweenCycles: number;
  startDate?: string;
  // 手动改「当前第几天」留下的偏移。0 = 完全按 startDate 自动推算；
  // 改一次后后续每天仍自动往后推进，不会永远钉在同一天。
  dayOffset?: number;
}

export interface WorkoutSessionPlan {
  dayIndex?: number;
  dayName?: string;
  muscleGroups?: MuscleGroup[];
  exercises: TemplateExercise[];
}

// 训练模板
export interface WorkoutTemplate {
  id: string;
  name: string;
  description?: string;
  days: TemplateDay[];
  schedule: TemplateSchedule;
  isPreset?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export type FoodCategory = 'protein' | 'carbs' | 'fats' | 'vegetables' | 'fruits' | 'other';

export interface FoodLibraryItem {
  id: string;
  name: string;
  category: FoodCategory;
  caloriesPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatsPer100g: number;
  isCustom?: boolean;
}

export type FoodLogSource = 'database' | 'custom' | 'quick';

// 餐次：每条饮食记录都必须有归属，AI 没给时按钟点推断（见 lib/nutrition-log.ts）。
export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export const MEAL_TYPE_NAMES: Record<MealType, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
};

export interface NutritionLogItem {
  id: string;
  foodId?: string;
  name: string;
  quantity: number;
  unit: 'g' | 'ml' | 'serving';
  calories: number;
  carbs: number;
  protein: number;
  fats: number;
  source: FoodLogSource;
  loggedAt: string;
  // 以下两项旧数据可能没有，故为可选；新写入的记录由 normalizeNutritionLogInput 保证齐全。
  mealType?: MealType;
  notes?: string;
}

export interface NutritionEntry {
  id: string;
  date: string;
  items: NutritionLogItem[];
  totalCalories: number;
  totalCarbs: number;
  totalProtein: number;
  totalFats: number;
  notes?: string;
}

// 饮食套餐：把「固定会吃的那一套食物」存成模板，之后一键整套餐记录到某一天。
// 单项结构与 NutritionLogItem 对齐（少掉运行时字段 id/loggedAt），这样套餐里保存的
// 份量和宏量和实际落库的记录完全一致，不会因按 100g 重算而和用户当时的记录对不上。
export interface MealComboItem {
  foodId?: string;
  name: string;
  quantity: number;
  unit: 'g' | 'ml' | 'serving';
  calories: number;
  carbs: number;
  protein: number;
  fats: number;
  source?: FoodLogSource;
  mealType?: MealType;
  notes?: string;
}

export interface MealCombo {
  id: string;
  name: string;
  items: MealComboItem[];
  /** 套餐默认餐次；单项 mealType 优先。未设置时按当前时间推断。 */
  mealType?: MealType;
  createdAt?: string;
  updatedAt?: string;
}

// 碳循环日类型
export type CarbDayType = 'high' | 'medium' | 'low';

// 碳循环模板中的一天
export interface CarbCycleDay {
  dayIndex: number;
  type: CarbDayType;
  calories: number;
  carbs: number;
  protein: number;
  fat: number;
}

// 碳循环模板
export interface CarbCyclePlan {
  id: string;
  name: string;
  cycleLength: number;
  days: CarbCycleDay[];
  startDate?: string;
}

// 体测记录
// 前 4 项为手工录入；其余对应米家 eco/scale 接口的 bodyData 字段，可缺省。
export interface BodyMetricEntry {
  id: string;
  date: string;
  weight?: number;      // kg
  bodyFat?: number;     // %
  bmi?: number;
  muscle?: number;         // kg
  water?: number;          // %
  bone?: number;           // kg
  heartRate?: number;      // bpm
  bodyAge?: number;        // 岁
  visceralFat?: number;    // 等级
  score?: number;          // 0-100
  ffmi?: number;           // 去脂体重指数
  bmr?: number;            // kcal/day
  skeletalMuscle?: number; // % 或 kg，视设备上报
  protein?: number;        // %
  source?: 'manual' | 'mi-scale' | 'import';
}

// 自定义营养方案：AI 给出的饮食营养参数建议落在这里，
// 在「饮食 → 营养建议 → 自定义」里查看/修改，并作为当前每日目标生效。
export interface CustomNutritionPlan {
  calories: number;
  protein: number;
  carbs: number;
  fats: number;
  note?: string;
  source: "ai" | "manual";
  updatedAt: string;
  enabled: boolean;
}

// 用户资料
export interface UserProfile {
  height?: number;
  age?: number;
  gender?: 'male' | 'female' | 'other';
  weightUnit: WeightUnit;
  restTimerMode: 'countUp' | 'countDown';
  defaultRestSeconds: number;
  includeWarmupInStats: boolean;
  activityLevel: ActivityLevel;
  nutritionGoal: NutritionGoal;
  activeWorkoutTemplateId?: string;
  activeCarbCyclePlanId?: string;
  favoriteFoodIds: string[];
  sleepHours?: number;
  customNutritionPlan?: CustomNutritionPlan;
}

// 动作能力记录
export interface ExerciseAbility {
  exerciseId: string;
  estimated1RM?: number;
  manual1RM?: number;
  maxWeight?: number;
  maxWeightReps?: number;
  lastUpdated: string;
}

// AI配置
export interface AIConfig {
  provider: 'dashscope' | 'kimi' | 'openai' | 'tokenhub' | 'custom';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  // 图片识别用的视觉模型；留空则复用上面的主模型（多数纯文本模型不支持图片）。
  visionModel?: string;
  // 单次回复最大输出 token（推理型模型需要更大预算，否则只输出 thinking 没有正文）。
  maxTokens?: number;
  // 是否把工具 schema 一起发给模型。自建 / agent 类网关常不支持 tools，关掉可显著降低推理负担。
  toolsEnabled?: boolean;
  isConfigured: boolean;
}

// 聊天消息里附带的图片元信息。
// 不把 base64 写进 AsyncStorage（大图会撑爆存储）：发送时把图片落到 App 文档目录，
// 这里只存一个本地文件 uri；老消息可能没有 uri（只有元信息），渲染时显示占位图。
export interface AIMessageImage {
  name?: string;
  mimeType: string;
  /** 持久化后的本地文件 uri（file://），跨页面/重启仍可显示 */
  uri?: string;
}

// AI消息
export interface AIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  // 旧版单图字段，保留以兼容已保存的消息；新消息统一用 images。
  image?: AIMessageImage;
  // 一次可附多张图片：只存元信息，图片本体在内存里按消息 id 索引。
  images?: AIMessageImage[];
  // 多图识别结果的文字汇总，仅作为模型上下文，不显示在聊天气泡里。
  imageAnalysis?: string;
  // 归档：主聊天列表只显示未归档消息；归档内容仍保存在本地，可在归档箱里删除/恢复。
  archived?: boolean;
}

// 训练目标
export type FitnessGoal = 'lose_fat' | 'maintain' | 'gain_muscle';

// 饮食目标
export type NutritionGoal = 'fat_loss' | 'maintenance' | 'muscle_gain';

// 活动水平
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';

// 饮食推荐配置
export interface DietRecommendation {
  goal: FitnessGoal;
  tdee: number;
  targetCalories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  proteinPercent: number;
  carbsPercent: number;
  fatPercent: number;
}

// 食物推荐项
export interface FoodRecommendation {
  name: string;
  category: 'protein' | 'carbs' | 'fat' | 'vegetable';
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  servingSize: string;
}

// 应用状态
export interface AppState {
  userProfile: UserProfile;
  exercises: Exercise[];
  workoutTemplates: WorkoutTemplate[];
  workoutSessions: WorkoutSession[];
  nutritionEntries: NutritionEntry[];
  mealCombos: MealCombo[];
  customFoods: FoodLibraryItem[];
  bodyMetrics: BodyMetricEntry[];
  exerciseAbilities: ExerciseAbility[];
  carbCyclePlans: CarbCyclePlan[];
  aiConfig: AIConfig;
  aiMessages: AIMessage[];
  currentSession?: WorkoutSession | null;
}

// 肌肉群中文名称映射
export const MUSCLE_GROUP_NAMES: Record<MuscleGroup, string> = {
  chest: '胸部',
  back: '背部',
  shoulders: '肩部',
  arms: '手臂',
  legs: '腿部',
  core: '核心',
};

// 器械中文名称映射
export const EQUIPMENT_NAMES: Record<Equipment, string> = {
  barbell: '杠铃',
  dumbbell: '哑铃',
  cable: '绳索',
  machine: '器械',
  bodyweight: '自重',
  kettlebell: '壶铃',
  bands: '弹力带',
  other: '其他',
};

// 碳日类型中文名称
export const CARB_DAY_NAMES: Record<CarbDayType, string> = {
  high: '高碳日',
  medium: '中碳日',
  low: '低碳日',
};

// 训练目标中文名称
export const FITNESS_GOAL_NAMES: Record<FitnessGoal, string> = {
  lose_fat: '减脂',
  maintain: '维持',
  gain_muscle: '增肌',
};

export const NUTRITION_GOAL_NAMES: Record<NutritionGoal, string> = {
  fat_loss: '减脂',
  maintenance: '维持',
  muscle_gain: '增肌',
};

// 活动水平中文名称
export const ACTIVITY_LEVEL_NAMES: Record<ActivityLevel, string> = {
  sedentary: '久坐（几乎不运动）',
  light: '轻度活动（每周1-3次）',
  moderate: '中度活动（每周3-5次）',
  active: '活跃（每周6-7次）',
  very_active: '非常活跃（每天高强度）',
};
