import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { TOKENHUB_BASE_URL, TOKENHUB_DEFAULT_MODEL, DEFAULT_MAX_TOKENS } from '../constants/ai-provider';
import { DEFAULT_SETS, DEFAULT_REPS } from '../constants/workout-defaults';
import type {
  Exercise,
  WorkoutTemplate,
  WorkoutSession,
  NutritionEntry,
  NutritionLogItem,
  MealCombo,
  MealComboItem,
  FoodLibraryItem,
  BodyMetricEntry,
  ExerciseAbility,
  CarbCyclePlan,
  UserProfile,
  AIConfig,
  AIMessage,
  AppState,
} from './types';
import { generateExercisesWithIds, PRESET_TEMPLATES, getExerciseIdByName } from './preset-exercises';

// 存储键名
const STORAGE_KEYS = {
  USER_PROFILE: '@health_app:user_profile',
  EXERCISES: '@health_app:exercises',
  WORKOUT_TEMPLATES: '@health_app:workout_templates',
  WORKOUT_SESSIONS: '@health_app:workout_sessions',
  NUTRITION_ENTRIES: '@health_app:nutrition_entries',
  MEAL_COMBOS: '@health_app:meal_combos',
  CUSTOM_FOODS: '@health_app:custom_foods',
  BODY_METRICS: '@health_app:body_metrics',
  EXERCISE_ABILITIES: '@health_app:exercise_abilities',
  CARB_CYCLE_PLANS: '@health_app:carb_cycle_plans',
  AI_CONFIG: '@health_app:ai_config',
  AI_MESSAGES: '@health_app:ai_messages',
  CURRENT_SESSION: '@health_app:current_session',
};

// 默认用户配置
export const DEFAULT_USER_PROFILE: UserProfile = {
  weightUnit: 'kg',
  restTimerMode: 'countUp',
  defaultRestSeconds: 90,
  includeWarmupInStats: false,
  activityLevel: 'moderate',
  nutritionGoal: 'maintenance',
  favoriteFoodIds: [],
  sleepHours: 7,
};

// 默认AI配置：只填一个 API Key 就能用，地址与模型内置
export const DEFAULT_AI_CONFIG: AIConfig = {
  provider: 'tokenhub',
  baseUrl: TOKENHUB_BASE_URL,
  model: TOKENHUB_DEFAULT_MODEL,
  maxTokens: DEFAULT_MAX_TOKENS,
  toolsEnabled: true,
  isConfigured: false,
};

// API Key 单独放系统加密区（Android Keystore / iOS Keychain）。
// 不能写进 AsyncStorage：那里的内容会随「导出备份」变成明文文件被分享出去。
const SECURE_API_KEY = 'fitlife.tokenhub.api_key';
let webOnlyKey = ''; // Web 预览只放内存，刷新即失效，不落盘

async function saveAPIKey(apiKey: string): Promise<void> {
  const key = apiKey.trim();
  if (Platform.OS === 'web') {
    webOnlyKey = key;
    return;
  }
  if (!key) {
    await SecureStore.deleteItemAsync(SECURE_API_KEY).catch(() => undefined);
    return;
  }
  await SecureStore.setItemAsync(SECURE_API_KEY, key);
}

async function loadAPIKey(): Promise<string> {
  if (Platform.OS === 'web') return webOnlyKey;
  return (await SecureStore.getItemAsync(SECURE_API_KEY).catch(() => null)) ?? '';
}

// 通用存储方法
async function setItem<T>(key: string, value: T): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error(`Error saving ${key}:`, error);
    throw error;
  }
}

async function getItem<T>(key: string, defaultValue: T): Promise<T> {
  try {
    const value = await AsyncStorage.getItem(key);
    return value ? JSON.parse(value) : defaultValue;
  } catch (error) {
    console.error(`Error loading ${key}:`, error);
    return defaultValue;
  }
}

// 用户配置
export async function saveUserProfile(profile: UserProfile): Promise<void> {
  await setItem(STORAGE_KEYS.USER_PROFILE, profile);
}

export async function loadUserProfile(): Promise<UserProfile> {
  const stored = await getItem<UserProfile>(STORAGE_KEYS.USER_PROFILE, DEFAULT_USER_PROFILE);
  return {
    ...DEFAULT_USER_PROFILE,
    ...stored,
    favoriteFoodIds: stored.favoriteFoodIds ?? DEFAULT_USER_PROFILE.favoriteFoodIds,
  };
}

// 动作库
export async function saveExercises(exercises: Exercise[]): Promise<void> {
  await setItem(STORAGE_KEYS.EXERCISES, exercises);
}

export async function loadExercises(): Promise<Exercise[]> {
  const stored = await getItem<Exercise[]>(STORAGE_KEYS.EXERCISES, []);
  // 如果没有存储的动作，返回预设动作
  if (stored.length === 0) {
    const presetExercises = generateExercisesWithIds();
    await saveExercises(presetExercises);
    return presetExercises;
  }
  return stored;
}

// 训练模板
export async function saveWorkoutTemplates(templates: WorkoutTemplate[]): Promise<void> {
  await setItem(STORAGE_KEYS.WORKOUT_TEMPLATES, templates);
}

function normalizeTemplateDays(rawDays: any[], exercises: Exercise[]) {
  const hasZeroBased = rawDays.some((day) => Number(day.dayIndex) === 0);
  return rawDays.map((day, index) => {
    const rawIndex = Number(day.dayIndex ?? index + 1);
    const dayIndex = hasZeroBased ? index + 1 : rawIndex <= 0 ? index + 1 : rawIndex;
    const name = day.name || `Day ${dayIndex}`;

    let exercisesList = [];
    if (Array.isArray(day.exercises)) {
      exercisesList = day.exercises.map((ex: any, exIndex: number) => ({
        id: ex.id ?? generateId(),
        exerciseId: ex.exerciseId ?? ex.id,
        // 模板里改过的动作名必须原样保留，否则重启后被动作库原名覆盖。
        name: typeof ex.name === "string" ? ex.name : undefined,
        order: Number(ex.order ?? exIndex + 1),
        sets: Number(ex.sets ?? DEFAULT_SETS),
        reps: Number(ex.reps ?? DEFAULT_REPS),
        weight: ex.weight !== undefined ? Number(ex.weight) : undefined,
        restSeconds: ex.restSeconds !== undefined ? Number(ex.restSeconds) : undefined,
        notes: ex.notes,
      }));
    } else if (Array.isArray(day.exerciseIds)) {
      exercisesList = day.exerciseIds.map((id: string, exIndex: number) => ({
        id: generateId(),
        exerciseId: id,
        order: exIndex + 1,
        sets: DEFAULT_SETS,
        reps: DEFAULT_REPS,
      }));
    } else if (Array.isArray(day.exerciseNames)) {
      exercisesList = day.exerciseNames
        .map((name: string, exIndex: number) => {
          const exerciseId = getExerciseIdByName(exercises, name);
          if (!exerciseId) return null;
          return {
            id: generateId(),
            exerciseId,
            order: exIndex + 1,
            sets: DEFAULT_SETS,
            reps: DEFAULT_REPS,
          };
        })
        .filter(Boolean);
    }

    const muscleGroups =
      Array.isArray(day.muscleGroups) && day.muscleGroups.length > 0
        ? day.muscleGroups
        : Array.from(
            new Set(
              exercisesList
                .map((ex: any) => exercises.find((e) => e.id === ex.exerciseId)?.muscleGroup)
                .filter(Boolean)
            )
          );

    return {
      dayIndex,
      name,
      muscleGroups,
      exercises: exercisesList.sort((a: any, b: any) => a.order - b.order),
    };
  });
}

function normalizeWorkoutTemplate(template: any, exercises: Exercise[]): WorkoutTemplate {
  const days = normalizeTemplateDays(Array.isArray(template.days) ? template.days : [], exercises);
  const trainingDaysPerWeek =
    Number(template.schedule?.trainingDaysPerWeek ?? template.trainingDaysPerWeek ?? days.length) ||
    days.length;
  const restDaysBetweenCycles = Number(
    template.schedule?.restDaysBetweenCycles ?? template.restDaysBetweenCycles ?? 0
  );
  const schedule = {
    trainingDaysPerWeek,
    restDaysBetweenCycles: restDaysBetweenCycles < 0 ? 0 : restDaysBetweenCycles,
    startDate: template.schedule?.startDate ?? template.startDate,
    // 手动切换「当前第几天」的偏移必须保留，否则重载后进度会被重置
    dayOffset: Number(template.schedule?.dayOffset ?? 0) || 0,
  };

  return {
    id: template.id ?? generateId(),
    name: template.name ?? '未命名模板',
    description: template.description,
    days,
    schedule,
    isPreset: template.isPreset,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

export async function loadWorkoutTemplates(): Promise<WorkoutTemplate[]> {
  const stored = await getItem<any[]>(STORAGE_KEYS.WORKOUT_TEMPLATES, []);
  // 如果没有存储的模板，生成预设模板
  if (stored.length === 0) {
    const exercises = await loadExercises();
    const presetTemplates: WorkoutTemplate[] = PRESET_TEMPLATES.map((template, index) =>
      normalizeWorkoutTemplate(
        {
          ...template,
          id: `preset_template_${index + 1}`,
          schedule: {
            trainingDaysPerWeek: template.days.length,
            restDaysBetweenCycles: 0,
          },
        },
        exercises
      )
    );
    await saveWorkoutTemplates(presetTemplates);
    return presetTemplates;
  }

  const exercises = await loadExercises();
  const normalized = stored.map((template) => normalizeWorkoutTemplate(template, exercises));
  if (JSON.stringify(normalized) !== JSON.stringify(stored)) {
    await saveWorkoutTemplates(normalized);
  }
  return normalized;
}

// 训练会话
export async function saveWorkoutSessions(sessions: WorkoutSession[]): Promise<void> {
  await setItem(STORAGE_KEYS.WORKOUT_SESSIONS, sessions);
}

export async function loadWorkoutSessions(): Promise<WorkoutSession[]> {
  return getItem(STORAGE_KEYS.WORKOUT_SESSIONS, []);
}

// 营养记录
export async function saveNutritionEntries(entries: NutritionEntry[]): Promise<void> {
  await setItem(STORAGE_KEYS.NUTRITION_ENTRIES, entries);
}

export async function loadNutritionEntries(): Promise<NutritionEntry[]> {
  const stored = await getItem<any[]>(STORAGE_KEYS.NUTRITION_ENTRIES, []);
  if (stored.length === 0) return [];
  if (Array.isArray(stored[0]?.items)) {
    return stored as NutritionEntry[];
  }

  const grouped: Record<string, NutritionEntry> = {};
  stored.forEach((entry) => {
    const date = entry.date || getTodayString();
    if (!grouped[date]) {
      grouped[date] = {
        id: generateId(),
        date,
        items: [],
        totalCalories: 0,
        totalCarbs: 0,
        totalProtein: 0,
        totalFats: 0,
      };
    }

    const item: NutritionLogItem = {
      id: entry.id ?? generateId(),
      name: entry.foodName ?? '食物',
      quantity: entry.quantity ?? 100,
      unit: entry.unit ?? 'g',
      calories: Number(entry.calories ?? 0),
      carbs: Number(entry.carbs ?? 0),
      protein: Number(entry.protein ?? 0),
      fats: Number(entry.fats ?? 0),
      source: 'quick',
      loggedAt: entry.loggedAt ?? new Date().toISOString(),
    };

    grouped[date].items.push(item);
    grouped[date].totalCalories += item.calories;
    grouped[date].totalCarbs += item.carbs;
    grouped[date].totalProtein += item.protein;
    grouped[date].totalFats += item.fats;
  });

  const normalized = Object.values(grouped).sort((a, b) => b.date.localeCompare(a.date));
  await saveNutritionEntries(normalized);
  return normalized;
}

// 饮食套餐：把固定吃的那几样食物存成一套，之后一键整套餐记到某天。
const MEAL_UNITS: MealComboItem["unit"][] = ["g", "ml", "serving"];
const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"];

function normalizeComboItem(raw: any): MealComboItem | null {
  const name = String(raw?.name ?? "").trim();
  if (!name) return null;
  const unit = MEAL_UNITS.includes(raw?.unit) ? raw.unit : "g";
  return {
    foodId: raw.foodId,
    name,
    quantity: Number(raw.quantity ?? 100) || 100,
    unit,
    calories: Number(raw.calories ?? 0) || 0,
    carbs: Number(raw.carbs ?? 0) || 0,
    protein: Number(raw.protein ?? 0) || 0,
    fats: Number(raw.fats ?? 0) || 0,
    source: ["database", "custom", "quick"].includes(raw?.source) ? raw.source : "quick",
    mealType: MEAL_TYPES.includes(raw?.mealType) ? raw.mealType : undefined,
    notes: typeof raw?.notes === "string" && raw.notes.trim() ? raw.notes.trim() : undefined,
  };
}

function normalizeMealCombo(raw: any): MealCombo | null {
  const name = String(raw?.name ?? "").trim();
  const items = Array.isArray(raw?.items)
    ? raw.items.map(normalizeComboItem).filter((i: MealComboItem | null): i is MealComboItem => !!i)
    : [];
  if (!name && items.length === 0) return null;
  return {
    id: raw.id ?? generateId(),
    name: name || "未命名套餐",
    items,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

export async function saveMealCombos(combos: MealCombo[]): Promise<void> {
  await setItem(STORAGE_KEYS.MEAL_COMBOS, combos);
}

export async function loadMealCombos(): Promise<MealCombo[]> {
  const stored = await getItem<any[]>(STORAGE_KEYS.MEAL_COMBOS, []);
  if (!Array.isArray(stored)) return [];
  return stored.map(normalizeMealCombo).filter((c: MealCombo | null): c is MealCombo => !!c);
}

// 自定义食物库
export async function saveCustomFoods(foods: FoodLibraryItem[]): Promise<void> {
  await setItem(STORAGE_KEYS.CUSTOM_FOODS, foods);
}

export async function loadCustomFoods(): Promise<FoodLibraryItem[]> {
  return getItem(STORAGE_KEYS.CUSTOM_FOODS, []);
}

// 体测记录
export async function saveBodyMetrics(metrics: BodyMetricEntry[]): Promise<void> {
  await setItem(STORAGE_KEYS.BODY_METRICS, metrics);
}

export async function loadBodyMetrics(): Promise<BodyMetricEntry[]> {
  return getItem(STORAGE_KEYS.BODY_METRICS, []);
}

// 动作能力
export async function saveExerciseAbilities(abilities: ExerciseAbility[]): Promise<void> {
  await setItem(STORAGE_KEYS.EXERCISE_ABILITIES, abilities);
}

export async function loadExerciseAbilities(): Promise<ExerciseAbility[]> {
  return getItem(STORAGE_KEYS.EXERCISE_ABILITIES, []);
}

// 碳循环计划
export async function saveCarbCyclePlans(plans: CarbCyclePlan[]): Promise<void> {
  await setItem(STORAGE_KEYS.CARB_CYCLE_PLANS, plans);
}

export async function loadCarbCyclePlans(): Promise<CarbCyclePlan[]> {
  return getItem(STORAGE_KEYS.CARB_CYCLE_PLANS, []);
}

// AI配置：只持久化非敏感字段，Key 走加密区
export async function saveAIConfig(config: AIConfig): Promise<void> {
  const { apiKey = '', ...safeConfig } = config;
  await saveAPIKey(apiKey);
  await setItem(STORAGE_KEYS.AI_CONFIG, { ...safeConfig, apiKey: '' });
}

export async function loadAIConfig(): Promise<AIConfig> {
  const stored = await getItem<Partial<AIConfig>>(STORAGE_KEYS.AI_CONFIG, {});
  const secureKey = await loadAPIKey();
  // 兼容旧版本：曾把 Key 明文存在 AsyncStorage，读到后迁移进加密区并抹掉。
  const legacyKey = stored.apiKey?.trim() ?? '';
  if (legacyKey) {
    await saveAPIKey(legacyKey);
    await setItem(STORAGE_KEYS.AI_CONFIG, { ...stored, apiKey: '' });
  }
  return {
    ...DEFAULT_AI_CONFIG,
    ...stored,
    baseUrl: stored.baseUrl || DEFAULT_AI_CONFIG.baseUrl,
    model: stored.model || DEFAULT_AI_CONFIG.model,
    apiKey: secureKey || legacyKey,
  };
}

// AI消息
export async function saveAIMessages(messages: AIMessage[]): Promise<void> {
  await setItem(STORAGE_KEYS.AI_MESSAGES, messages);
}

export async function loadAIMessages(): Promise<AIMessage[]> {
  const stored = await getItem<AIMessage[]>(STORAGE_KEYS.AI_MESSAGES, []);
  if (!Array.isArray(stored)) return [];
  // 旧版本或导入的备份可能缺 id / 字段异常。FlatList 用 id 做 key，
  // 缺 id 或重复 id 会让消息渲染错乱甚至不显示，这里统一补全并过滤脏数据。
  const seen = new Set<string>();
  return stored
    .filter(
      (m): m is AIMessage =>
        !!m &&
        typeof m.content === 'string' &&
        (m.role === 'user' || m.role === 'assistant' || m.role === 'system')
    )
    .map((m) => {
      let id = m.id;
      if (!id || seen.has(id)) id = generateId();
      seen.add(id);
      return {
        ...m,
        id,
        timestamp: m.timestamp || new Date().toISOString(),
      };
    });
}

// 当前训练会话
export async function saveCurrentSession(session: WorkoutSession | null): Promise<void> {
  if (session) {
    await setItem(STORAGE_KEYS.CURRENT_SESSION, session);
  } else {
    await AsyncStorage.removeItem(STORAGE_KEYS.CURRENT_SESSION);
  }
}

export async function loadCurrentSession(): Promise<WorkoutSession | null> {
  try {
    const value = await AsyncStorage.getItem(STORAGE_KEYS.CURRENT_SESSION);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

// 导出所有数据
export async function exportAllData(): Promise<AppState> {
  const [
    userProfile,
    exercises,
    workoutTemplates,
    workoutSessions,
    nutritionEntries,
    mealCombos,
    customFoods,
    bodyMetrics,
    exerciseAbilities,
    carbCyclePlans,
    aiConfig,
    aiMessages,
    currentSession,
  ] = await Promise.all([
    loadUserProfile(),
    loadExercises(),
    loadWorkoutTemplates(),
    loadWorkoutSessions(),
    loadNutritionEntries(),
    loadMealCombos(),
    loadCustomFoods(),
    loadBodyMetrics(),
    loadExerciseAbilities(),
    loadCarbCyclePlans(),
    loadAIConfig(),
    loadAIMessages(),
    loadCurrentSession(),
  ]);

  return {
    userProfile,
    exercises,
    workoutTemplates,
    workoutSessions,
    nutritionEntries,
    mealCombos,
    customFoods,
    bodyMetrics,
    exerciseAbilities,
    carbCyclePlans,
    // 导出备份绝不带 Key（备份文件可能被分享/上传）
    aiConfig: { ...aiConfig, apiKey: '' },
    aiMessages,
    currentSession: currentSession ?? undefined,
  };
}

// 体测记录按日期合并：同一天保留已有 id，新数据只覆盖实际带值的字段。
// 自动同步/导入必须走这里，不能直接 saveBodyMetrics（那是整表覆盖，会冲掉历史）。
export function mergeBodyMetrics(
  existing: BodyMetricEntry[],
  incoming: BodyMetricEntry[]
): BodyMetricEntry[] {
  const byDate = new Map<string, BodyMetricEntry>();
  for (const entry of existing) {
    if (entry?.date) byDate.set(entry.date, entry);
  }
  for (const entry of incoming) {
    if (!entry?.date) continue;
    const prev = byDate.get(entry.date);
    if (!prev) {
      byDate.set(entry.date, { ...entry, id: entry.id || generateId() });
      continue;
    }
    // 只让非空值覆盖，避免上游缺字段把本地已填的数据清成 undefined
    const patch: Partial<BodyMetricEntry> = {};
    for (const [k, v] of Object.entries(entry)) {
      if (k === 'id' || k === 'date') continue;
      if (v !== undefined && v !== null && v !== '') {
        (patch as Record<string, unknown>)[k] = v;
      }
    }
    byDate.set(entry.date, { ...prev, ...patch, id: prev.id });
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// 导入所有数据
export async function importAllData(data: Partial<AppState>): Promise<void> {
  const promises: Promise<void>[] = [];

  if (data.userProfile) {
    promises.push(saveUserProfile(data.userProfile));
  }
  if (data.exercises) {
    promises.push(saveExercises(data.exercises));
  }
  if (data.workoutTemplates) {
    promises.push(saveWorkoutTemplates(data.workoutTemplates));
  }
  if (data.workoutSessions) {
    promises.push(saveWorkoutSessions(data.workoutSessions));
  }
  if (data.nutritionEntries) {
    promises.push(saveNutritionEntries(data.nutritionEntries));
  }
  if (data.mealCombos) {
    promises.push(saveMealCombos(data.mealCombos));
  }
  if (data.customFoods) {
    promises.push(saveCustomFoods(data.customFoods));
  }
  if (data.bodyMetrics) {
    promises.push(saveBodyMetrics(data.bodyMetrics));
  }
  if (data.exerciseAbilities) {
    promises.push(saveExerciseAbilities(data.exerciseAbilities));
  }
  if (data.carbCyclePlans) {
    promises.push(saveCarbCyclePlans(data.carbCyclePlans));
  }
  if (data.aiConfig) {
    // 导入文件里的 Key 一律丢弃，避免旧备份把明文 Key 带回来
    promises.push(saveAIConfig({ ...DEFAULT_AI_CONFIG, ...data.aiConfig, apiKey: '' }));
  }
  if (data.aiMessages) {
    promises.push(saveAIMessages(data.aiMessages));
  }

  await Promise.all(promises);
}

// 清除所有数据
export async function clearAllData(): Promise<void> {
  const keys = Object.values(STORAGE_KEYS);
  await Promise.all([AsyncStorage.multiRemove(keys), saveAPIKey('')]);
}

// 生成唯一ID
// 加自增序号：同一毫秒内连续发多条消息也不会撞 ID（FlatList 用 id 做 key，撞了会漏渲染）。
let idCounter = 0;
export function generateId(): string {
  idCounter = (idCounter + 1) % 1000000;
  return `${Date.now()}_${idCounter}_${Math.random().toString(36).substring(2, 9)}`;
}

// 获取今天的日期字符串 (YYYY-MM-DD)
export function getTodayString(): string {
  return new Date().toISOString().split('T')[0];
}

// 获取当前时间字符串 (HH:mm:ss)
export function getCurrentTimeString(): string {
  return new Date().toTimeString().split(' ')[0];
}
