// AI 工具调用层：把模型返回的 tool_calls 分发到 useApp 的真实写操作。
// 这是「AI 操控 App」的核心——模型不再只会说话，能真正增删改训练/饮食/体测等数据。
import type { AppContextType } from "../app-context";
import type {
  MuscleGroup,
  Equipment,
  FoodCategory,
  CarbDayType,
  NutritionLogItem,
  WorkoutTemplate,
  TemplateExercise,
  Exercise,
} from "../types";
import { MUSCLE_GROUP_NAMES, EQUIPMENT_NAMES, MEAL_TYPE_NAMES } from "../types";
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
      name: "query_workout_templates",
      description:
        "查看训练方案的具体内容：每个训练日、每天有哪些动作、各做几组几次、重量/休息/备注、每周排期。用户问「我的计划是什么」「第几天练什么」或要改某动作前先调这个看清楚。省略参数列出所有方案；给 name/id 查某个方案；activeOnly=true 只看当前生效的。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "方案 ID，最精确" },
          name: { type: "string", description: "方案名称，模糊匹配" },
          activeOnly: { type: "boolean", description: "只返回当前生效的方案，默认 false" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_workout_template",
      description:
        "修改一个已有训练方案的具体内容（不是新建）。先用 query_workout_templates 看清 dayIndex 和动作列表。支持：改方案名/说明/排期；用 days 整体替换所有训练日（结构同 create_workout_template）；或用 operations 做精确增删改——add_day / remove_day / update_day / add_exercise / remove_exercise / update_exercise。dayIndex 与 exerciseIndex 都是从 0 开始的下标，来自查询结果。动作可用 name 引用，已存在则复用、不存在则自动新建。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "方案 ID，最精确" },
          name: { type: "string", description: "方案名称，模糊匹配（定位用）" },
          newName: { type: "string", description: "改成的新方案名" },
          description: { type: "string", description: "改成的新说明" },
          trainingDaysPerWeek: { type: "number", description: "每周训练天数" },
          restDaysBetweenCycles: { type: "number", description: "循环间休息天数" },
          startDate: { type: "string", description: "开始日期 YYYY-MM-DD" },
          days: {
            type: "array",
            description: "整体替换全部训练日（提供后忽略 operations 里的 day/exercise 操作）",
            items: {
              type: "object",
              properties: {
                dayIndex: { type: "number" },
                name: { type: "string" },
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
                      displayName: { type: "string", description: "方案内显示的自定义名称（可选）" },
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
                      sets: { type: "number" },
                      reps: { type: "number" },
                      weight: { type: "number" },
                      restSeconds: { type: "number" },
                      notes: { type: "string" },
                    },
                    required: ["name"],
                  },
                },
              },
              required: ["exercises"],
            },
          },
          operations: {
            type: "array",
            description: "按顺序执行的精确修改操作",
            items: {
              type: "object",
              properties: {
                op: {
                  type: "string",
                  enum: [
                    "add_day",
                    "remove_day",
                    "update_day",
                    "add_exercise",
                    "remove_exercise",
                    "update_exercise",
                  ],
                },
                dayIndex: { type: "number", description: "目标训练日下标（0 起）；add_day 可省略" },
                exerciseIndex: { type: "number", description: "目标动作下标（0 起）" },
                name: { type: "string", description: "新增动作名 / update_day 的新天名" },
                displayName: { type: "string", description: "方案内显示名（可选）" },
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
                muscleGroups: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: ["chest", "back", "shoulders", "arms", "legs", "core"],
                  },
                },
                sets: { type: "number" },
                reps: { type: "number" },
                weight: { type: "number" },
                restSeconds: { type: "number" },
                notes: { type: "string" },
                exercises: {
                  type: "array",
                  description: "add_day 时这个训练日包含的动作",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      displayName: { type: "string" },
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
                      sets: { type: "number" },
                      reps: { type: "number" },
                      weight: { type: "number" },
                      restSeconds: { type: "number" },
                      notes: { type: "string" },
                    },
                    required: ["name"],
                  },
                },
              },
              required: ["op"],
            },
          },
        },
        required: [],
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
      name: "query_nutrition",
      description:
        "查询/查看已有的饮食记录（回答「我昨天吃了什么」「这周热量多少」等问题时用）。可按单日、日期范围、食物名、餐次筛选；返回每条记录的 id、份量、热量与三大宏量以及每日合计。要删除/修改记录但没带 id 时，先用这个拿到准确的 id。",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "查询单日 YYYY-MM-DD，省略则查最近几天" },
          startDate: { type: "string", description: "起始日期 YYYY-MM-DD（含）" },
          endDate: { type: "string", description: "结束日期 YYYY-MM-DD（含）" },
          name: { type: "string", description: "按食物名模糊筛选" },
          mealType: {
            type: "string",
            enum: ["breakfast", "lunch", "dinner", "snack"],
            description: "按餐次筛选",
          },
          limit: { type: "number", description: "最多返回几天，默认 7" },
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

/** 把 AI 传入的动作描述转成模板动作配置项；动作按名称复用或自动新建。 */
async function buildTemplateExercise(
  app: AppContextType,
  raw: Record<string, any>,
  order: number
): Promise<TemplateExercise> {
  const ex = await resolveExercise(
    app,
    raw.name,
    raw.muscleGroup as MuscleGroup | undefined,
    raw.equipment as Equipment | undefined
  );
  return {
    id: generateId(),
    exerciseId: ex.id,
    name: typeof raw.displayName === "string" && raw.displayName.trim() ? raw.displayName.trim() : undefined,
    order,
    sets: Number(raw.sets ?? DEFAULT_SETS) || DEFAULT_SETS,
    reps: Number(raw.reps ?? DEFAULT_REPS) || DEFAULT_REPS,
    weight: raw.weight != null ? Number(raw.weight) : undefined,
    restSeconds: raw.restSeconds != null ? Number(raw.restSeconds) : undefined,
    notes: typeof raw.notes === "string" && raw.notes.trim() ? raw.notes.trim().slice(0, 200) : undefined,
  };
}

/** 把训练日描述转成模板训练日；dayIndex 缺失时按当前下标补。 */
async function buildTemplateDay(
  app: AppContextType,
  raw: Record<string, any>,
  fallbackIndex: number
) {
  const exercises: TemplateExercise[] = [];
  for (const ex of raw.exercises || []) {
    exercises.push(await buildTemplateExercise(app, ex, exercises.length));
  }
  return {
    dayIndex: typeof raw.dayIndex === "number" ? raw.dayIndex : fallbackIndex,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : `第${fallbackIndex + 1}天`,
    muscleGroups: (raw.muscleGroups ?? []) as MuscleGroup[],
    exercises,
  };
}

/** 按 id 或名称定位一个训练方案。 */
function findTemplate(app: AppContextType, args: Record<string, any>): WorkoutTemplate | undefined {
  if (hasArg(args, "id")) {
    const byId = app.state.workoutTemplates.find((t) => t.id === args.id);
    if (byId) return byId;
  }
  if (hasArg(args, "name")) {
    const key = String(args.name).trim().toLowerCase();
    return app.state.workoutTemplates.find(
      (t) => t.name.toLowerCase().includes(key) || key.includes(t.name.toLowerCase())
    );
  }
  return undefined;
}

/** 训练方案的可读摘要，供模型核对并据此给出 dayIndex / exerciseIndex。 */
function formatTemplate(app: AppContextType, tpl: WorkoutTemplate): string {
  const s = tpl.schedule || ({} as WorkoutTemplate["schedule"]);
  const lines: string[] = [
    `【${tpl.name}】${tpl.id === app.state.userProfile.activeWorkoutTemplateId ? "（当前生效）" : ""}`,
    `- ID: ${tpl.id}`,
    `- 每周 ${s.trainingDaysPerWeek ?? "?"} 练 / 循环间休 ${s.restDaysBetweenCycles ?? "?"} 天 / 起始 ${s.startDate ?? "未设"}`,
  ];
  if (tpl.description) lines.push(`- 说明: ${tpl.description}`);
  tpl.days.forEach((day, dayIndex) => {
    const groups = (day.muscleGroups || []).map((g) => MUSCLE_GROUP_NAMES[g] || g).join("/");
    lines.push(`- 第${dayIndex + 1}天[index=${dayIndex}] ${day.name}${groups ? `（${groups}）` : ""}`);
    day.exercises.forEach((te, exerciseIndex) => {
      const ex = app.state.exercises.find((e: Exercise) => e.id === te.exerciseId);
      const label = te.name || ex?.name || te.exerciseId;
      const equip = ex ? EQUIPMENT_NAMES[ex.equipment] : "";
      lines.push(
        `    [${exerciseIndex}] ${label}${equip ? `·${equip}` : ""} ${te.sets}组×${te.reps}次` +
          `${te.weight != null ? ` @${te.weight}` : ""}${te.restSeconds != null ? ` 休${te.restSeconds}s` : ""}` +
          `${te.notes ? ` — ${te.notes}` : ""}`
      );
    });
  });
  return lines.join("\n");
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

      case "query_workout_templates": {
        let templates = [...app.state.workoutTemplates];
        if (args.activeOnly === true) {
          templates = templates.filter(
            (t) => t.id === app.state.userProfile.activeWorkoutTemplateId
          );
        } else if (hasArg(args, "id")) {
          templates = templates.filter((t) => t.id === args.id);
        } else if (hasArg(args, "name")) {
          const key = String(args.name).trim().toLowerCase();
          templates = templates.filter(
            (t) => t.name.toLowerCase().includes(key) || key.includes(t.name.toLowerCase())
          );
        }
        if (!templates.length) {
          return { ok: false, summary: "没有查到训练方案，可去掉筛选条件再查。" };
        }
        return {
          ok: true,
          summary: `查到 ${templates.length} 个训练方案：\n\n${templates
            .map((t) => formatTemplate(app, t))
            .join("\n\n")}\n\n提示：删除或精确修改时，用上面的 ID；改某一天/某个动作用 [index] 里的下标。`,
        };
      }

      case "update_workout_template": {
        const tpl = findTemplate(app, args);
        if (!tpl) {
          return { ok: false, summary: "未找到要修改的训练方案，请给出方案名称或 ID；可先用 query_workout_templates 查看。" };
        }
        const next: WorkoutTemplate = {
          ...tpl,
          days: tpl.days.map((d) => ({ ...d, exercises: d.exercises.map((e) => ({ ...e })) })),
          schedule: { ...tpl.schedule },
        };
        const changes: string[] = [];

        if (hasArg(args, "newName")) {
          next.name = String(args.newName).trim().slice(0, 80);
          changes.push(`改名「${next.name}」`);
        }
        if (hasArg(args, "description")) {
          next.description = String(args.description).trim().slice(0, 300);
          changes.push("更新说明");
        }
        if (typeof args.trainingDaysPerWeek === "number") {
          next.schedule.trainingDaysPerWeek = Math.max(1, Math.round(args.trainingDaysPerWeek));
          changes.push(`每周 ${next.schedule.trainingDaysPerWeek} 练`);
        }
        if (typeof args.restDaysBetweenCycles === "number") {
          next.schedule.restDaysBetweenCycles = Math.max(0, Math.round(args.restDaysBetweenCycles));
          changes.push(`循环间休 ${next.schedule.restDaysBetweenCycles} 天`);
        }
        if (DATE_PATTERN.test(String(args.startDate ?? ""))) {
          next.schedule.startDate = String(args.startDate);
          changes.push(`起始日 ${args.startDate}`);
        }

        // days：整体替换全部训练日
        if (Array.isArray(args.days) && args.days.length) {
          const rebuilt = [];
          for (let i = 0; i < args.days.length; i++) {
            rebuilt.push(await buildTemplateDay(app, args.days[i], i));
          }
          next.days = rebuilt;
          changes.push(`整体替换为 ${rebuilt.length} 个训练日`);
        } else {
          // operations：按顺序做精确增删改
          for (const op of Array.isArray(args.operations) ? args.operations : []) {
            const di = typeof op.dayIndex === "number" ? Math.round(op.dayIndex) : -1;
            const day = di >= 0 ? next.days[di] : undefined;
            switch (op.op) {
              case "add_day": {
                const built = await buildTemplateDay(app, op, next.days.length);
                next.days.push(built);
                changes.push(`新增第${next.days.length}天「${built.name}」`);
                break;
              }
              case "remove_day": {
                if (!day) {
                  changes.push(`跳过 remove_day：找不到第 ${di} 天`);
                  break;
                }
                const [removed] = next.days.splice(di, 1);
                next.days.forEach((d, i) => (d.dayIndex = i));
                changes.push(`删除「${removed.name}」`);
                break;
              }
              case "update_day": {
                if (!day) {
                  changes.push(`跳过 update_day：找不到第 ${di} 天`);
                  break;
                }
                if (hasArg(op, "name")) {
                  day.name = String(op.name).trim().slice(0, 60);
                }
                if (Array.isArray(op.muscleGroups)) {
                  day.muscleGroups = op.muscleGroups as MuscleGroup[];
                }
                changes.push(`更新「${day.name}」`);
                break;
              }
              case "add_exercise": {
                if (!day) {
                  changes.push(`跳过 add_exercise：找不到第 ${di} 天`);
                  break;
                }
                const te = await buildTemplateExercise(app, op, day.exercises.length);
                day.exercises.push(te);
                const ex = app.state.exercises.find((e: Exercise) => e.id === te.exerciseId);
                changes.push(`「${day.name}」加动作 ${te.name || ex?.name || "?"}`);
                break;
              }
              case "remove_exercise": {
                if (!day || typeof op.exerciseIndex !== "number") {
                  changes.push("跳过 remove_exercise：下标无效");
                  break;
                }
                const ei = Math.round(op.exerciseIndex);
                const [removed] = day.exercises.splice(ei, 1);
                day.exercises.forEach((e, i) => (e.order = i));
                changes.push(removed ? `「${day.name}」删动作 ${removed.name || removed.exerciseId}` : "跳过 remove_exercise：动作下标越界");
                break;
              }
              case "update_exercise": {
                if (!day || typeof op.exerciseIndex !== "number") {
                  changes.push("跳过 update_exercise：下标无效");
                  break;
                }
                const te = day.exercises[Math.round(op.exerciseIndex)];
                if (!te) {
                  changes.push("跳过 update_exercise：动作下标越界");
                  break;
                }
                if (hasArg(op, "name") || hasArg(op, "displayName")) {
                  const ex = await resolveExercise(
                    app,
                    op.name,
                    op.muscleGroup as MuscleGroup | undefined,
                    op.equipment as Equipment | undefined
                  );
                  te.exerciseId = ex.id;
                  if (hasArg(op, "displayName")) te.name = String(op.displayName).trim().slice(0, 60);
                }
                if (typeof op.sets === "number") te.sets = Math.max(1, Math.round(op.sets));
                if (typeof op.reps === "number") te.reps = Math.max(1, Math.round(op.reps));
                if (typeof op.weight === "number") te.weight = op.weight;
                if (typeof op.restSeconds === "number") te.restSeconds = Math.max(0, Math.round(op.restSeconds));
                if (hasArg(op, "notes")) te.notes = String(op.notes).trim().slice(0, 200) || undefined;
                changes.push(`「${day.name}」改第 ${Math.round(op.exerciseIndex)} 个动作`);
                break;
              }
              default:
                changes.push(`跳过未知操作：${op.op}`);
            }
          }
        }

        next.updatedAt = new Date().toISOString();
        await app.updateWorkoutTemplate(next);
        return {
          ok: true,
          summary: `已修改训练方案「${next.name}」（ID ${next.id}）：\n${changes.length ? changes.map((c) => `· ${c}`).join("\n") : "· 无实际变更"}`,
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

      case "query_nutrition": {
        const start = DATE_PATTERN.test(String(args.startDate ?? "")) ? String(args.startDate) : undefined;
        const end = DATE_PATTERN.test(String(args.endDate ?? "")) ? String(args.endDate) : undefined;
        const single = DATE_PATTERN.test(String(args.date ?? "")) ? String(args.date) : undefined;
        const from = single ?? start;
        const to = single ?? end;
        const limit = Math.max(1, Math.min(Number(args.limit) || 7, 30));
        const nameFilter = hasArg(args, "name") ? String(args.name) : undefined;
        const mealFilter = NUTRITION_MEAL_TYPES.includes(args.mealType) ? args.mealType : undefined;

        let entries = [...app.state.nutritionEntries].sort((a, b) => b.date.localeCompare(a.date));
        if (from) entries = entries.filter((e) => e.date >= from);
        if (to) entries = entries.filter((e) => e.date <= to);
        entries = entries.slice(0, limit);

        const blocks: string[] = [];
        for (const entry of entries) {
          let items = entry.items;
          if (nameFilter) items = items.filter((i) => matchesName(i.name, nameFilter));
          if (mealFilter) items = items.filter((i) => i.mealType === mealFilter);
          if (!items.length) continue;
          const lines = items.map(
            (i) =>
              `  · id=${i.id}｜${i.name} ${i.quantity}${i.unit}｜${i.calories}kcal｜` +
              `蛋白 ${i.protein}g／碳水 ${i.carbs}g／脂肪 ${i.fats}g` +
              `${i.mealType ? `｜${MEAL_TYPE_NAMES[i.mealType]}` : ""}`
          );
          const cal = items.reduce((s, i) => s + i.calories, 0);
          blocks.push(`【${entry.date}】${items.length} 项，共 ${Math.round(cal)} kcal（当日合计 ${Math.round(entry.totalCalories)} kcal）：\n${lines.join("\n")}`);
        }
        if (!blocks.length) {
          return { ok: false, summary: "没有查到符合条件的饮食记录，可以放宽日期或去掉筛选条件。" };
        }
        return {
          ok: true,
          summary: `查到 ${blocks.length} 天的饮食记录：\n${blocks.join("\n\n")}\n\n提示：上面的 id 可用于 delete_nutrition / update_nutrition 精确删改。`,
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
