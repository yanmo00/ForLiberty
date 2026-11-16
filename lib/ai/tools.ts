// AI 工具调用层：把模型返回的 tool_calls 分发到 useApp 的真实写操作。
// 这是「AI 操控 App」的核心——模型不再只会说话，能真正增删改训练/饮食/体测等数据。
import type { AppContextType } from "../app-context";
import type {
  MuscleGroup,
  Equipment,
  FoodCategory,
  CarbDayType,
  NutritionLogItem,
} from "../types";
import { generateId, getTodayString } from "../storage";
import { buildCustomNutritionPlan, formatPlanSummary } from "../nutrition-plan";
import { summarizeNutritionLogItem } from "../nutrition-log";
import { DEFAULT_SETS, DEFAULT_REPS } from "../../constants/workout-defaults";

export interface ToolResult {
  ok: boolean;
  summary: string;
}

// ── 工具 Schema（OpenAI 兼容）────────────────────────────────────────────
export const AI_TOOLS: Record<string, unknown>[] = [
  {
    type: "function",
    function: {
      name: "update_profile",
      description: "更新用户的个人资料（身高/年龄/性别/活动水平/饮食目标/睡眠等）。只传要改的字段。",
      parameters: {
        type: "object",
        properties: {
          height: { type: "number", description: "身高 cm" },
          age: { type: "number", description: "年龄" },
          gender: { type: "string", enum: ["male", "female", "other"] },
          activityLevel: {
            type: "string",
            enum: ["sedentary", "light", "moderate", "active", "very_active"],
          },
          nutritionGoal: {
            type: "string",
            enum: ["fat_loss", "maintenance", "muscle_gain"],
          },
          sleepHours: { type: "number", description: "每日睡眠小时数" },
          weightUnit: { type: "string", enum: ["kg", "lb"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_exercise",
      description: "新增一个训练动作到动作库。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "动作名称，如 卧推" },
          muscleGroup: {
            type: "string",
            enum: ["chest", "back", "shoulders", "arms", "legs", "core"],
          },
          equipment: {
            type: "string",
            enum: [
              "barbell",
              "dumbbell",
              "cable",
              "machine",
              "bodyweight",
              "kettlebell",
              "bands",
              "other",
            ],
          },
          description: { type: "string" },
          defaultSets: { type: "number", description: `默认组数，省略为 ${DEFAULT_SETS}` },
          defaultReps: { type: "number", description: `默认次数，省略为 ${DEFAULT_REPS}` },
          defaultWeight: { type: "number" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_body_metric",
      description: "记录一次体测数据（体重/体脂/BMI/肌肉量等）。可只传有的字段。",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "日期 YYYY-MM-DD，省略则用今天" },
          weight: { type: "number", description: "体重 kg" },
          bodyFat: { type: "number", description: "体脂率 %" },
          bmi: { type: "number" },
          muscle: { type: "number", description: "肌肉量 kg" },
          water: { type: "number", description: "水分 %" },
          bone: { type: "number", description: "骨量 kg" },
          heartRate: { type: "number", description: "心率 bpm" },
          bodyAge: { type: "number", description: "身体年龄" },
          visceralFat: { type: "number", description: "内脏脂肪等级" },
          score: { type: "number", description: "综合评分 0-100" },
          bmr: { type: "number", description: "基础代谢 kcal" },
          skeletalMuscle: { type: "number" },
          protein: { type: "number", description: "蛋白质 %" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_workout_template",
      description:
        "创建一个完整的训练计划模板（含多天、每天多动作）。动作可用 name 引用（已存在则复用，不存在则自动新建）。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "计划名称" },
          description: { type: "string" },
          trainingDaysPerWeek: { type: "number", description: "每周训练天数" },
          restDaysBetweenCycles: { type: "number", description: "循环间休息天数" },
          startDate: { type: "string", description: "开始日期 YYYY-MM-DD" },
          days: {
            type: "array",
            description: "训练日数组",
            items: {
              type: "object",
              properties: {
                dayIndex: { type: "number" },
                name: { type: "string", description: "如 推日 / 拉日" },
                muscleGroups: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: ["chest", "back", "shoulders", "arms", "legs", "core"],
                  },
                },
                exercises: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string", description: "动作名称" },
                      muscleGroup: {
                        type: "string",
                        enum: ["chest", "back", "shoulders", "arms", "legs", "core"],
                      },
                      equipment: {
                        type: "string",
                        enum: [
                          "barbell",
                          "dumbbell",
                          "cable",
                          "machine",
                          "bodyweight",
                          "kettlebell",
                          "bands",
                          "other",
                        ],
                      },
                      sets: { type: "number", description: "组数" },
                      reps: { type: "number", description: "次数" },
                      weight: { type: "number", description: "建议重量" },
                      restSeconds: { type: "number", description: "组间休息秒" },
                      notes: { type: "string" },
                    },
                    required: ["name"],
                  },
                },
              },
              required: ["exercises"],
            },
          },
        },
        required: ["name", "days"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_active_template",
      description: "把某个训练计划设为当前生效计划（按名称模糊匹配）。",
      parameters: {
        type: "object",
        properties: { templateName: { type: "string" } },
        required: ["templateName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_workout_session",
      description: "开始一次训练（可指定计划名称，留空则自由训练）。",
      parameters: {
        type: "object",
        properties: {
          templateName: { type: "string", description: "计划名称，省略为自由训练" },
          date: { type: "string", description: "YYYY-MM-DD，省略为今天" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_set_to_session",
      description: "给「进行中」的训练加一组。需先 start_workout_session。",
      parameters: {
        type: "object",
        properties: {
          exerciseId: { type: "string", description: "已有动作 ID" },
          exerciseName: { type: "string", description: "动作名称（无 ID 时按名查找/新建）" },
          muscleGroup: {
            type: "string",
            enum: ["chest", "back", "shoulders", "arms", "legs", "core"],
          },
          equipment: {
            type: "string",
            enum: [
              "barbell",
              "dumbbell",
              "cable",
              "machine",
              "bodyweight",
              "kettlebell",
              "bands",
              "other",
            ],
          },
          setIndex: { type: "number", description: "第几组（从 0 或 1 起均可）" },
          isWarmup: { type: "boolean" },
          weight: { type: "number", description: "重量" },
          reps: { type: "number", description: "次数" },
          restSeconds: { type: "number" },
        },
        required: ["weight", "reps"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "end_workout_session",
      description: "结束当前进行中的训练并记录。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "log_nutrition",
      description:
        "记录一条饮食。必须写全：食物名、份量、单位、热量、蛋白/碳水/脂肪、餐次。只给食物名或只给热量会让记录残缺；数值不确定就按常见食物估算，确实为 0 才填 0。一餐里有多种食物请改用 log_meal。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "食物名称" },
          quantity: { type: "number", description: "份量数值：g/ml 填克或毫升，serving 填份数" },
          unit: { type: "string", enum: ["g", "ml", "serving"] },
          calories: { type: "number", description: "热量 kcal" },
          carbs: { type: "number", description: "碳水 g" },
          protein: { type: "number", description: "蛋白质 g" },
          fats: { type: "number", description: "脂肪 g" },
          mealType: {
            type: "string",
            enum: ["breakfast", "lunch", "dinner", "snack"],
            description: "早餐/午餐/晚餐/加餐，省略按当前时间推断",
          },
          date: { type: "string", description: "YYYY-MM-DD，省略为今天" },
          foodId: { type: "string", description: "食物库 ID，省略时按名称自动匹配" },
          source: { type: "string", enum: ["database", "custom", "quick"] },
          notes: { type: "string", description: "备注（做法、品牌等）" },
        },
        required: ["name", "quantity", "unit", "calories", "carbs", "protein", "fats"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_meal",
      description:
        "一次记录一餐里的所有食物（推荐）。用户说「早餐吃了鸡蛋、牛奶、面包」时必须把每样食物逐项列出，不要合并成一条、也不要只记第一样。每项都要写全份量、单位、热量与三大宏量。",
      parameters: {
        type: "object",
        properties: {
          mealType: {
            type: "string",
            enum: ["breakfast", "lunch", "dinner", "snack"],
            description: "这一餐的餐次，省略按当前时间推断",
          },
          date: { type: "string", description: "YYYY-MM-DD，省略为今天" },
          notes: { type: "string", description: "整餐备注" },
          items: {
            type: "array",
            description: "这餐吃的所有食物，逐项列出",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "食物名称" },
                quantity: { type: "number", description: "份量数值" },
                unit: { type: "string", enum: ["g", "ml", "serving"] },
                calories: { type: "number" },
                carbs: { type: "number" },
                protein: { type: "number" },
                fats: { type: "number" },
                foodId: { type: "string" },
                source: { type: "string", enum: ["database", "custom", "quick"] },
                notes: { type: "string" },
              },
              required: ["name", "quantity", "calories", "carbs", "protein", "fats"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_nutrition",
      description:
        "删除已有的饮食记录（用户说删掉/取消/不要那条食物时必须用这个）。优先用 id（来自上下文的今日饮食明细），也可用食物名模糊匹配；默认只删今天，今天没有就删最近一条匹配的日期；allDates=true 则跨所有日期删。注意：删除就是删除，绝不要用 log_meal / log_nutrition 重新记录一套来「覆盖」，那会留下重复记录。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "饮食记录 ID，最精确" },
          name: { type: "string", description: "食物名称，模糊匹配" },
          date: { type: "string", description: "YYYY-MM-DD，省略为今天/最近匹配日" },
          mealType: {
            type: "string",
            enum: ["breakfast", "lunch", "dinner", "snack"],
            description: "限定餐次",
          },
          allDates: { type: "boolean", description: "跨所有日期删除匹配项，默认 false" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_nutrition",
      description:
        "修改一条已有的饮食记录（份量、热量、宏量、餐次、备注）。用户想改记录时用这个，不要先删再加。只改 quantity 且带 scaleMacros=true 时，热量与三大宏量会按原记录的比例同步变化（适合原本不是 100g 的记录）。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "记录 ID，最精确" },
          name: { type: "string", description: "食物名称，模糊匹配" },
          date: { type: "string", description: "YYYY-MM-DD，省略为今天/最近匹配日" },
          quantity: { type: "number", description: "新份量数值" },
          unit: { type: "string", enum: ["g", "ml", "serving"] },
          calories: { type: "number" },
          carbs: { type: "number" },
          protein: { type: "number" },
          fats: { type: "number" },
          mealType: {
            type: "string",
            enum: ["breakfast", "lunch", "dinner", "snack"],
          },
          notes: { type: "string" },
          scaleMacros: {
            type: "boolean",
            description: "只改 quantity 时按原记录比例同步热量与宏量，默认 false",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_custom_food",
      description: "往食物库加一个自定义食物（每 100g 营养）。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          category: {
            type: "string",
            enum: ["protein", "carbs", "fats", "vegetables", "fruits", "other"],
          },
          caloriesPer100g: { type: "number" },
          proteinPer100g: { type: "number" },
          carbsPer100g: { type: "number" },
          fatsPer100g: { type: "number" },
        },
        required: ["name", "caloriesPer100g"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_carb_cycle_plan",
      description: "创建一个碳循环饮食计划（高/中/低碳日）。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          cycleLength: { type: "number", description: "循环天数" },
          startDate: { type: "string" },
          days: {
            type: "array",
            items: {
              type: "object",
              properties: {
                dayIndex: { type: "number" },
                type: {
                  type: "string",
                  enum: ["high", "medium", "low"],
                },
                calories: { type: "number" },
                carbs: { type: "number" },
                protein: { type: "number" },
                fat: { type: "number" },
              },
              required: ["type", "calories", "carbs", "protein", "fat"],
            },
          },
        },
        required: ["name", "days"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_exercise",
      description: "删除动作库里的动作（按名称或 ID）。",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_workout_template",
      description: "删除一个训练计划（按名称或 ID）。",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_body_metric",
      description: "删除一条体测记录（按日期或 ID）。",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, date: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_custom_nutrition_plan",
      description:
        "把 AI 给出的饮食营养参数建议（每日热量/蛋白质/碳水/脂肪）保存到「饮食 → 营养建议 → 自定义」并设为当前生效的每日目标。当用户询问饮食营养建议、热量或宏量分配，或你主动给出一套具体数值方案时调用。",
      parameters: {
        type: "object",
        properties: {
          calories: { type: "number", description: "每日热量 kcal" },
          protein: { type: "number", description: "每日蛋白质 g" },
          carbs: { type: "number", description: "每日碳水 g" },
          fats: { type: "number", description: "每日脂肪 g" },
          note: { type: "string", description: "一句话说明方案依据，可省略" },
        },
        required: ["calories", "protein", "carbs", "fats"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clear_custom_nutrition_plan",
      description: "清除「营养建议 → 自定义」里的自定义营养方案，恢复按预设目标公式计算每日目标。",
      parameters: { type: "object", properties: {} },
    },
  },
];

// ── 动作分发 ──────────────────────────────────────────────────────────
async function resolveExercise(
  app: AppContextType,
  name?: string,
  muscleGroup: MuscleGroup = "legs",
  equipment: Equipment = "other"
) {
  if (!name) throw new Error("动作名称不能为空");
  const existing = app.state.exercises.find(
    (e) => e.name.toLowerCase() === String(name).toLowerCase()
  );
  if (existing) return existing;
  return app.addExercise({ name, muscleGroup, equipment });
}

type NutritionCandidate = { date: string; item: NutritionLogItem };

const NUTRITION_MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function hasArg(args: Record<string, any>, key: string): boolean {
  const value = args[key];
  return value !== undefined && value !== null && value !== "";
}

function matchesName(itemName: string, query: string): boolean {
  const a = itemName.toLowerCase();
  const b = query.trim().toLowerCase();
  return !!b && (a.includes(b) || b.includes(a));
}

/** 收集所有带日期的饮食条目，用于按 id/名称/餐次/日期定位。 */
function allNutritionItems(app: AppContextType): NutritionCandidate[] {
  return app.state.nutritionEntries.flatMap((entry) =>
    entry.items.map((item) => ({ date: entry.date, item }))
  );
}

/** 删除用：可命中多条；未指定日期时优先今天，再退到最近一条匹配的日期。 */
function findNutritionForDelete(
  app: AppContextType,
  args: Record<string, any>
): NutritionCandidate[] {
  const allDates = args.allDates === true;
  const dateGiven = DATE_PATTERN.test(String(args.date ?? ""));

  let pool = allNutritionItems(app).filter(
    (c) => allDates || !dateGiven || c.date === args.date
  );
  if (hasArg(args, "id")) pool = pool.filter((c) => c.item.id === args.id);
  if (hasArg(args, "name")) pool = pool.filter((c) => matchesName(c.item.name, String(args.name)));
  if (NUTRITION_MEAL_TYPES.includes(args.mealType)) {
    pool = pool.filter((c) => c.item.mealType === args.mealType);
  }

  if (!allDates && !dateGiven && !hasArg(args, "id") && pool.length > 0) {
    const dates = Array.from(new Set(pool.map((c) => c.date))).sort((a, b) => b.localeCompare(a));
    pool = pool.filter((c) => c.date === dates[0]);
  }
  return pool;
}

/** 修改用：只取一条，id 优先；名称匹配时优先今天，再退到最近日期。 */
function findNutritionForUpdate(
  app: AppContextType,
  args: Record<string, any>
): NutritionCandidate | undefined {
  const all = allNutritionItems(app);
  if (hasArg(args, "id")) {
    const byId = all.find((c) => c.item.id === args.id);
    if (byId) return byId;
  }
  if (!hasArg(args, "name")) return undefined;

  let pool = all.filter((c) => matchesName(c.item.name, String(args.name)));
  if (DATE_PATTERN.test(String(args.date ?? ""))) {
    pool = pool.filter((c) => c.date === args.date);
  } else {
    const today = getTodayString();
    const todayMatches = pool.filter((c) => c.date === today);
    if (todayMatches.length) {
      pool = todayMatches;
    } else if (pool.length) {
      const latest = pool.map((c) => c.date).sort((a, b) => b.localeCompare(a))[0];
      pool = pool.filter((c) => c.date === latest);
    }
  }
  if (NUTRITION_MEAL_TYPES.includes(args.mealType)) {
    pool = pool.filter((c) => c.item.mealType === args.mealType);
  }
  return pool[0];
}

export async function executeToolCall(
  name: string,
  args: Record<string, any>,
  app: AppContextType
): Promise<ToolResult> {
  try {
    switch (name) {
      case "update_profile": {
        await app.updateUserProfile(args);
        const fields = Object.keys(args).join("、");
        return { ok: true, summary: `已更新个人资料${fields ? `：${fields}` : ""}` };
      }

      case "add_exercise": {
        const ex = await app.addExercise({
          name: args.name,
          muscleGroup: (args.muscleGroup ?? "legs") as MuscleGroup,
          equipment: (args.equipment ?? "other") as Equipment,
          description: args.description,
          defaultSets: args.defaultSets ?? DEFAULT_SETS,
          defaultReps: args.defaultReps ?? DEFAULT_REPS,
          defaultWeight: args.defaultWeight,
        });
        return { ok: true, summary: `已添加动作：${ex.name}` };
      }

      case "log_body_metric": {
        const { date, ...rest } = args;
        const metric = await app.addBodyMetric({ date: date || getTodayString(), ...rest });
        return {
          ok: true,
          summary: `已记录体测（${metric.date}）：${
            metric.weight != null ? `体重 ${metric.weight}kg ` : ""
          }${metric.bodyFat != null ? `体脂 ${metric.bodyFat}%` : ""}`.trim(),
        };
      }

      case "create_workout_template": {
        const days = [];
        for (const d of args.days || []) {
          const exercises = [];
          for (const ex of d.exercises || []) {
            const e = await resolveExercise(
              app,
              ex.name,
              ex.muscleGroup as MuscleGroup,
              ex.equipment as Equipment
            );
            exercises.push({
              id: generateId(),
              exerciseId: e.id,
              order: exercises.length,
              sets: ex.sets ?? DEFAULT_SETS,
              reps: ex.reps ?? DEFAULT_REPS,
              weight: ex.weight,
              restSeconds: ex.restSeconds,
              notes: ex.notes,
            });
          }
          days.push({
            dayIndex: d.dayIndex ?? days.length,
            name: d.name ?? `第${(d.dayIndex ?? days.length) + 1}天`,
            muscleGroups: (d.muscleGroups ?? []) as MuscleGroup[],
            exercises,
          });
        }
        const tpl = await app.addWorkoutTemplate({
          name: args.name,
          description: args.description,
          days,
          schedule: {
            trainingDaysPerWeek: args.trainingDaysPerWeek ?? days.length,
            restDaysBetweenCycles: args.restDaysBetweenCycles ?? 1,
            startDate: args.startDate,
          },
        });
        return {
          ok: true,
          summary: `已创建训练计划「${tpl.name}」，共 ${days.length} 天`,
        };
      }

      case "set_active_template": {
        const tpl = app.state.workoutTemplates.find((t) =>
          t.name.includes(args.templateName)
        );
        if (!tpl) return { ok: false, summary: `找不到训练计划：${args.templateName}` };
        await app.updateUserProfile({ activeWorkoutTemplateId: tpl.id });
        // 缺 startDate 时周期推算会一直以「今天」为锚点，训练日永远停在第 1 天
        if (!tpl.schedule?.startDate) {
          await app.updateWorkoutTemplate({
            ...tpl,
            schedule: { ...tpl.schedule, startDate: getTodayString() },
          });
        }
        return { ok: true, summary: `已设为当前计划：「${tpl.name}」` };
      }

      case "start_workout_session": {
        const tpl = args.templateName
          ? app.state.workoutTemplates.find((t) => t.name.includes(args.templateName))
          : undefined;
        app.startWorkoutSession(tpl);
        return {
          ok: true,
          summary: `已开始训练${tpl ? `：${tpl.name}` : "（自由训练）"}`,
        };
      }

      case "add_set_to_session": {
        if (!app.state.currentSession)
          return {
            ok: false,
            summary: "当前没有进行中的训练，请先调用 start_workout_session",
          };
        const ex = args.exerciseId
          ? app.getExerciseById(args.exerciseId)
          : await resolveExercise(
              app,
              args.exerciseName,
              args.muscleGroup as MuscleGroup,
              args.equipment as Equipment
            );
        if (!ex) return { ok: false, summary: "找不到对应动作" };
        app.addSetToSession({
          exerciseId: ex.id,
          setIndex: args.setIndex ?? app.state.currentSession.sets.length,
          isWarmup: args.isWarmup ?? false,
          weight: args.weight ?? 0,
          reps: args.reps ?? DEFAULT_REPS,
          restSeconds: args.restSeconds,
        });
        return {
          ok: true,
          summary: `已添加第 ${app.state.currentSession.sets.length + 1} 组：${ex.name} ${args.weight ?? 0}×${args.reps ?? DEFAULT_REPS}`,
        };
      }

      case "end_workout_session": {
        if (!app.state.currentSession)
          return { ok: false, summary: "当前没有进行中的训练" };
        await app.endWorkoutSession();
        return { ok: true, summary: "已结束并记录本次训练" };
      }

      // 单条与整餐共用同一套写入路径。字段的最终补全（食物库折算宏量、foodId、
      // source、餐次、单位）由 app.addNutritionEntry → normalizeNutritionLogInput 统一完成，
      // 所以即使模型漏填也不会出现只剩食物名的残缺记录。
      case "log_nutrition":
      case "log_meal": {
        const rawItems: any[] = name === "log_meal"
          ? Array.isArray(args.items) ? args.items : []
          : [args];
        if (!rawItems.length) {
          return { ok: false, summary: "没有可记录的食物：items 为空" };
        }
        const lines: string[] = [];
        let savedDate = args.date || getTodayString();
        for (const raw of rawItems) {
          const draft = {
            date: args.date || raw.date || getTodayString(),
            name: String(raw.name ?? ""),
            foodId: raw.foodId,
            quantity: Number(raw.quantity ?? 100),
            unit: (raw.unit ?? "g") as "g" | "ml" | "serving",
            calories: Number(raw.calories ?? 0),
            carbs: Number(raw.carbs ?? 0),
            protein: Number(raw.protein ?? 0),
            fats: Number(raw.fats ?? 0),
            source: (raw.source ?? "quick") as "database" | "custom" | "quick",
            mealType: raw.mealType ?? args.mealType,
            notes: raw.notes ?? args.notes,
          } as Parameters<AppContextType["addNutritionEntry"]>[0];
          const entry = await app.addNutritionEntry(draft);
          savedDate = entry.date;
          const last = entry.items[entry.items.length - 1];
          if (last) lines.push(`· ${summarizeNutritionLogItem(last)}`);
        }
        return {
          ok: true,
          summary: `已完整记录 ${lines.length} 项饮食（${savedDate}）：\n${lines.join("\n")}`,
        };
      }

      // 删除/修改走 app 的串行写入口；按 id / 名称 / 日期 / 餐次定位到具体的某条记录，
      // 不再靠「重新记一遍正确的」去覆盖旧的——那正是重复记录的根源。
      case "delete_nutrition": {
        const hasFilter =
          hasArg(args, "id") ||
          hasArg(args, "name") ||
          hasArg(args, "mealType") ||
          DATE_PATTERN.test(String(args.date ?? "")) ||
          args.allDates === true;
        if (!hasFilter) {
          return {
            ok: false,
            summary: "为避免误删，请说明要删除的食物名称、餐次、日期或记录 ID；清空全部请明确说 allDates。",
          };
        }
        const targets = findNutritionForDelete(app, args);
        if (!targets.length) {
          return { ok: false, summary: "未找到匹配的饮食记录，可换个食物名或给出日期再试。" };
        }
        const lines: string[] = [];
        for (const target of targets) {
          await app.deleteNutritionEntry(target.date, target.item.id);
          lines.push(`· ${target.date} ${summarizeNutritionLogItem(target.item)}`);
        }
        return {
          ok: true,
          summary: `已删除 ${lines.length} 条饮食记录：\n${lines.join("\n")}`,
        };
      }

      case "update_nutrition": {
        const found = findNutritionForUpdate(app, args);
        if (!found) {
          return { ok: false, summary: "未找到要修改的饮食记录，请给出食物名称、日期或记录 ID。" };
        }
        const patch: Partial<NutritionLogItem> = {};
        const macroKeys = ["calories", "carbs", "protein", "fats"];
        if (hasArg(args, "quantity")) {
          const quantity = Number(args.quantity);
          if (Number.isFinite(quantity) && quantity > 0) {
            patch.quantity = quantity;
            // 只改克数 + scaleMacros：按原记录自身的份量/营养折算，而不是食物库每100g。
            if (args.scaleMacros === true && !macroKeys.some((key) => hasArg(args, key))) {
              const base = Number(found.item.quantity) || 0;
              if (base > 0) {
                const ratio = quantity / base;
                const r1 = (n: number) => Math.round(n * 10) / 10;
                patch.calories = Math.round(found.item.calories * ratio);
                patch.carbs = r1(found.item.carbs * ratio);
                patch.protein = r1(found.item.protein * ratio);
                patch.fats = r1(found.item.fats * ratio);
              }
            }
          }
        }
        if (hasArg(args, "unit") && ["g", "ml", "serving"].includes(args.unit)) {
          patch.unit = args.unit;
        }
        for (const key of macroKeys) {
          if (hasArg(args, key)) {
            const value = Number(args[key]);
            if (Number.isFinite(value) && value >= 0) {
              (patch as Record<string, number>)[key] = value;
            }
          }
        }
        if (NUTRITION_MEAL_TYPES.includes(args.mealType)) patch.mealType = args.mealType;
        if (hasArg(args, "notes")) patch.notes = String(args.notes).slice(0, 200) || undefined;

        if (!Object.keys(patch).length) {
          return { ok: false, summary: "没有可更新的字段，请给出新的份量或营养数值。" };
        }
        const updated: NutritionLogItem = { ...found.item, ...patch };
        await app.updateNutritionEntry(found.date, updated);
        return {
          ok: true,
          summary: `已修改饮食记录（${found.date}）：${summarizeNutritionLogItem(updated)}`,
        };
      }

      case "add_custom_food": {
        const f = await app.addCustomFood({
          name: args.name,
          category: (args.category ?? "other") as FoodCategory,
          caloriesPer100g: args.caloriesPer100g ?? 0,
          proteinPer100g: args.proteinPer100g ?? 0,
          carbsPer100g: args.carbsPer100g ?? 0,
          fatsPer100g: args.fatsPer100g ?? 0,
        });
        return { ok: true, summary: `已添加食物：${f.name}` };
      }

      case "create_carb_cycle_plan": {
        const plan = await app.addCarbCyclePlan({
          name: args.name,
          cycleLength: args.cycleLength ?? (args.days?.length || 7),
          startDate: args.startDate,
          days: (args.days || []).map((d: any) => ({
            dayIndex: d.dayIndex ?? 0,
            type: d.type as CarbDayType,
            calories: d.calories,
            carbs: d.carbs,
            protein: d.protein,
            fat: d.fat,
          })),
        });
        return {
          ok: true,
          summary: `已创建碳循环计划「${plan.name}」，共 ${plan.days.length} 天`,
        };
      }

      case "delete_exercise": {
        const ex = args.id
          ? app.getExerciseById(args.id)
          : app.state.exercises.find((e: any) => e.name.includes(args.name));
        if (!ex) return { ok: false, summary: "未找到动作" };
        await app.deleteExercise(ex.id);
        return { ok: true, summary: `已删除动作：${ex.name}` };
      }

      case "delete_workout_template": {
        const tpl = args.id
          ? app.state.workoutTemplates.find((t: any) => t.id === args.id)
          : app.state.workoutTemplates.find((t: any) => t.name.includes(args.name));
        if (!tpl) return { ok: false, summary: "未找到训练计划" };
        await app.deleteWorkoutTemplate(tpl.id);
        return { ok: true, summary: `已删除训练计划：「${tpl.name}」` };
      }

      case "delete_body_metric": {
        const m = args.id
          ? app.state.bodyMetrics.find((x: any) => x.id === args.id)
          : app.state.bodyMetrics.find(
              (x: any) => x.date === (args.date || getTodayString())
            );
        if (!m) return { ok: false, summary: "未找到体测记录" };
        await app.deleteBodyMetric(m.id);
        return { ok: true, summary: `已删除体测记录（${m.date}）` };
      }

      case "save_custom_nutrition_plan": {
        const plan = buildCustomNutritionPlan(
          {
            calories: Number(args.calories) || 0,
            protein: Number(args.protein) || 0,
            carbs: Number(args.carbs) || 0,
            fats: Number(args.fats) || 0,
          },
          "ai",
          typeof args.note === "string" ? args.note.slice(0, 200) : undefined
        );
        await app.updateUserProfile({ customNutritionPlan: plan });
        return {
          ok: true,
          summary: `已把营养建议存入「自定义」并设为每日目标：${formatPlanSummary(plan)}`,
        };
      }

      case "clear_custom_nutrition_plan": {
        await app.updateUserProfile({ customNutritionPlan: undefined });
        return { ok: true, summary: "已清除自定义营养方案，恢复预设公式" };
      }

      default:
        return { ok: false, summary: `未知工具：${name}` };
    }
  } catch (e) {
    return { ok: false, summary: `执行失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
