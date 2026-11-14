// AI 工具调用层：把模型返回的 tool_calls 分发到 useApp 的真实写操作。
// 这是「AI 操控 App」的核心——模型不再只会说话，能真正增删改训练/饮食/体测等数据。
import type { AppContextType } from "../app-context";
import type {
  MuscleGroup,
  Equipment,
  FoodCategory,
  CarbDayType,
} from "../types";
import { generateId, getTodayString } from "../storage";

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
          defaultSets: { type: "number" },
          defaultReps: { type: "number" },
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
      description: "记录一条饮食（食物名称 + 热量宏量）。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "食物名称" },
          quantity: { type: "number", description: "份量数值" },
          unit: { type: "string", enum: ["g", "ml", "serving"] },
          calories: { type: "number" },
          carbs: { type: "number" },
          protein: { type: "number" },
          fats: { type: "number" },
          date: { type: "string", description: "YYYY-MM-DD，省略为今天" },
          source: { type: "string", enum: ["database", "custom", "quick"] },
        },
        required: ["name", "quantity"],
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
          defaultSets: args.defaultSets,
          defaultReps: args.defaultReps,
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
              sets: ex.sets ?? 3,
              reps: ex.reps ?? 10,
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
          reps: args.reps ?? 0,
          restSeconds: args.restSeconds,
        });
        return {
          ok: true,
          summary: `已添加第 ${app.state.currentSession.sets.length + 1} 组：${ex.name} ${args.weight ?? 0}×${args.reps ?? 0}`,
        };
      }

      case "end_workout_session": {
        if (!app.state.currentSession)
          return { ok: false, summary: "当前没有进行中的训练" };
        await app.endWorkoutSession();
        return { ok: true, summary: "已结束并记录本次训练" };
      }

      case "log_nutrition": {
        const entry = await app.addNutritionEntry({
          date: args.date || getTodayString(),
          foodId: undefined,
          name: args.name,
          quantity: args.quantity,
          unit: (args.unit ?? "g") as "g" | "ml" | "serving",
          calories: args.calories ?? 0,
          carbs: args.carbs ?? 0,
          protein: args.protein ?? 0,
          fats: args.fats ?? 0,
          source: (args.source ?? "quick") as "database" | "custom" | "quick",
        });
        return {
          ok: true,
          summary: `已记录饮食（${entry.date}）：${args.name} ${args.calories ?? 0} kcal`,
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

      default:
        return { ok: false, summary: `未知工具：${name}` };
    }
  } catch (e) {
    return { ok: false, summary: `执行失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
