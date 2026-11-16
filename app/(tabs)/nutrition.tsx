import { useState, useMemo, useEffect } from "react";
import { Text, View, TouchableOpacity, TextInput, FlatList, SectionList, Alert, ScrollView, Modal } from "react-native";
import { useRouter } from "expo-router";
import { ScreenContainer } from "@/components/screen-container";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useColors } from "@/hooks/use-colors";
import { useApp } from "@/lib/app-context";
import { calculateNutritionRecommendation, getRecommendedFoods, getAllFoods } from "@/lib/nutrition-engine";
import { getCarbCycleDay } from "@/lib/carb-cycle";
import { getTodayString } from "@/lib/storage";
import { buildCustomNutritionPlan, formatPlanSummary, macroPercentages } from "@/lib/nutrition-plan";
import type { NutritionLogItem, FoodLibraryItem, NutritionGoal, FoodCategory, CarbCycleDay, CarbCyclePlan, MealType, MealCombo, MealComboItem } from "@/lib/types";
import { NUTRITION_GOAL_NAMES, CARB_DAY_NAMES, MEAL_TYPE_NAMES } from "@/lib/types";
import { inferMealType } from "@/lib/nutrition-log";

const FOOD_CATEGORIES: FoodCategory[] = ["protein", "carbs", "fats", "vegetables", "fruits", "other"];

export default function NutritionScreen() {
  const colors = useColors();
  const router = useRouter();
  const {
    state,
    addNutritionEntry,
    updateNutritionEntry,
    deleteNutritionEntry,
    addMealCombo,
    updateMealCombo,
    deleteMealCombo,
    addCustomFood,
    updateCustomFood,
    deleteCustomFood,
    addCarbCyclePlan,
    updateCarbCyclePlan,
    deleteCarbCyclePlan,
    updateUserProfile,
  } = useApp();

  const [activeTab, setActiveTab] = useState<"log" | "recommend" | "carb">("log");
  const [isAddingEntry, setIsAddingEntry] = useState(false);
  const [editingItem, setEditingItem] = useState<NutritionLogItem | null>(null);
  // 编辑记录时改克数，是否按「原记录份量 → 新份量」的比例同步热量/宏量。
  // 很多人导入的不是 100g，按每 100g 食物库重算会和当时的记录对不上，默认按比例。
  const [scaleByRatio, setScaleByRatio] = useState(true);

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFood, setSelectedFood] = useState<(FoodLibraryItem & { source: "database" | "custom" }) | null>(null);
  const [quantity, setQuantity] = useState("100");
  const [foodName, setFoodName] = useState("");
  const [calories, setCalories] = useState("");
  const [protein, setProtein] = useState("");
  const [carbs, setCarbs] = useState("");
  const [fats, setFats] = useState("");
  // 每条记录都要有餐次 / 单位 / 备注，和 AI 记录走同一套字段口径。
  const [entryMealType, setEntryMealType] = useState<MealType>(inferMealType());
  const [entryUnit, setEntryUnit] = useState<"g" | "ml" | "serving">("g");
  const [entryNotes, setEntryNotes] = useState("");
  const [date] = useState(getTodayString());

  // 饮食套餐：把固定吃的一套食物存成模板，点一下整套餐记进今天。
  const [showComboModal, setShowComboModal] = useState(false);
  const [comboName, setComboName] = useState("");
  const [comboItems, setComboItems] = useState<MealComboItem[]>([]);
  const [editingCombo, setEditingCombo] = useState<MealCombo | null>(null);
  const [comboSearch, setComboSearch] = useState("");
  const [comboDraftFood, setComboDraftFood] = useState<(FoodLibraryItem & { source: "database" | "custom" }) | null>(null);
  const [comboDraftQty, setComboDraftQty] = useState("100");

  const [showCustomFoodModal, setShowCustomFoodModal] = useState(false);
  const [customFoodName, setCustomFoodName] = useState("");
  const [customCategory, setCustomCategory] = useState<FoodCategory>("protein");
  const [customCalories, setCustomCalories] = useState("");
  const [customProtein, setCustomProtein] = useState("");
  const [customCarbs, setCustomCarbs] = useState("");
  const [customFats, setCustomFats] = useState("");
  const [editingFood, setEditingFood] = useState<FoodLibraryItem | null>(null);

  const [currentGoal, setCurrentGoal] = useState<NutritionGoal>(state.userProfile.nutritionGoal);
  // 「自定义」是第四个目标：AI 给出的营养参数存进 userProfile.customNutritionPlan，
  // 选中后优先于公式推荐，成为每日目标。
  const customPlan = state.userProfile.customNutritionPlan;
  const [useCustomPlan, setUseCustomPlan] = useState<boolean>(!!customPlan?.enabled);
  const [planCalories, setPlanCalories] = useState("");
  const [planProtein, setPlanProtein] = useState("");
  const [planCarbs, setPlanCarbs] = useState("");
  const [planFats, setPlanFats] = useState("");
  const [planNotice, setPlanNotice] = useState("");
  const [currentWeight, setCurrentWeight] = useState("");
  const [recommendation, setRecommendation] = useState<ReturnType<typeof calculateNutritionRecommendation> | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<FoodCategory | "all">("all");

  const [planName, setPlanName] = useState("");
  const [cycleLength, setCycleLength] = useState(7);
  const [planStartDate, setPlanStartDate] = useState(getTodayString());
  const [dayTypes, setDayTypes] = useState<("high" | "medium" | "low")[]>(Array.from({ length: 7 }, () => "medium"));
  const [macroByType, setMacroByType] = useState({
    high: { calories: "", carbs: "", protein: "", fat: "" },
    medium: { calories: "", carbs: "", protein: "", fat: "" },
    low: { calories: "", carbs: "", protein: "", fat: "" },
  });

  const activeCarbPlan = useMemo(() => {
    return state.carbCyclePlans.find((plan) => plan.id === state.userProfile.activeCarbCyclePlanId);
  }, [state.carbCyclePlans, state.userProfile.activeCarbCyclePlanId]);

  const todayEntry = useMemo(() => {
    return state.nutritionEntries.find((entry) => entry.date === date);
  }, [state.nutritionEntries, date]);

  const todayTotals = useMemo(() => {
    return {
      calories: todayEntry?.totalCalories || 0,
      protein: todayEntry?.totalProtein || 0,
      carbs: todayEntry?.totalCarbs || 0,
      fats: todayEntry?.totalFats || 0,
    };
  }, [todayEntry]);

  // 当日记录按早/中/晚三段分开，每段带自己的小计。
  // 加餐和旧数据（没记餐次）单独留一块，避免记录凭空消失。
  const mealSections = useMemo(() => {
    const items = todayEntry?.items || [];
    const build = (title: string, data: NutritionLogItem[]) => ({
      title,
      data,
      totalCalories: Math.round(data.reduce((sum, i) => sum + (Number(i.calories) || 0), 0)),
    });
    const sections = (["breakfast", "lunch", "dinner"] as MealType[]).map((m) =>
      build(MEAL_TYPE_NAMES[m], items.filter((i) => i.mealType === m))
    );
    const others = items.filter((i) => !i.mealType || i.mealType === "snack");
    if (others.length) sections.push(build("加餐 / 未分类", others));
    return sections;
  }, [todayEntry]);

  useEffect(() => {
    if (!currentWeight && state.bodyMetrics.length > 0) {
      const latest = [...state.bodyMetrics].sort((a, b) => b.date.localeCompare(a.date))[0];
      if (latest?.weight) {
        setCurrentWeight(String(latest.weight));
      }
    }
  }, [state.bodyMetrics, currentWeight]);

  useEffect(() => {
    if (currentGoal !== state.userProfile.nutritionGoal) {
      updateUserProfile({ nutritionGoal: currentGoal });
    }
  }, [currentGoal, state.userProfile.nutritionGoal, updateUserProfile]);

  // AI 在别的页面写入/更新了自定义方案后，这里自动切过去并同步输入框。
  useEffect(() => {
    if (customPlan?.enabled) setUseCustomPlan(true);
    if (customPlan) {
      setPlanCalories(String(customPlan.calories));
      setPlanProtein(String(customPlan.protein));
      setPlanCarbs(String(customPlan.carbs));
      setPlanFats(String(customPlan.fats));
    }
  }, [customPlan?.enabled, customPlan?.updatedAt]);

  const foodLibrary = useMemo(() => {
    const preset = getAllFoods().map((food) => ({ ...food, source: "database" as const })) as (FoodLibraryItem & { source: "database" })[];
    const custom = state.customFoods.map((food) => ({ ...food, source: "custom" as const })) as (FoodLibraryItem & { source: "custom" })[];
    return [...preset, ...custom];
  }, [state.customFoods]);

  const favoriteFoods = useMemo(() => {
    const favorites = state.userProfile.favoriteFoodIds || [];
    return foodLibrary.filter((food) => favorites.includes(food.id));
  }, [foodLibrary, state.userProfile.favoriteFoodIds]);

  const filteredFoods = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return foodLibrary.filter((food) => {
      const matchesQuery = !query || food.name.toLowerCase().includes(query);
      const matchesCategory = selectedCategory === "all" || food.category === selectedCategory;
      return matchesQuery && matchesCategory;
    });
  }, [foodLibrary, searchQuery, selectedCategory]);

  const comboFilteredFoods = useMemo(() => {
    const query = comboSearch.trim().toLowerCase();
    if (!query) return [];
    return foodLibrary.filter((food) => food.name.toLowerCase().includes(query)).slice(0, 30);
  }, [foodLibrary, comboSearch]);

  const handleSelectFood = (food: FoodLibraryItem & { source: "database" | "custom" }) => {
    setSelectedFood(food);
    setFoodName(food.name);
  };

  useEffect(() => {
    if (!selectedFood) return;
    const quantityNum = parseFloat(quantity) || 0;
    const multiplier = quantityNum / 100;
    setCalories((selectedFood.caloriesPer100g * multiplier).toFixed(0));
    setProtein((selectedFood.proteinPer100g * multiplier).toFixed(1));
    setCarbs((selectedFood.carbsPer100g * multiplier).toFixed(1));
    setFats((selectedFood.fatsPer100g * multiplier).toFixed(1));
  }, [selectedFood, quantity]);

  const handleSelectGoal = async (goal: NutritionGoal | "custom") => {
    setPlanNotice("");
    if (goal === "custom") {
      setUseCustomPlan(true);
      if (customPlan && !customPlan.enabled) {
        await updateUserProfile({ customNutritionPlan: { ...customPlan, enabled: true } });
      }
      return;
    }
    setCurrentGoal(goal);
    setUseCustomPlan(false);
    if (customPlan?.enabled) {
      await updateUserProfile({ customNutritionPlan: { ...customPlan, enabled: false } });
    }
  };

  const handleSaveCustomPlan = async () => {
    const c = Number(planCalories);
    if (!Number.isFinite(c) || c <= 0) {
      setPlanNotice("请输入有效的每日热量（kcal）");
      return;
    }
    const plan = buildCustomNutritionPlan(
      {
        calories: c,
        protein: Number(planProtein) || 0,
        carbs: Number(planCarbs) || 0,
        fats: Number(planFats) || 0,
      },
      "manual",
      customPlan?.note
    );
    await updateUserProfile({ customNutritionPlan: plan });
    setUseCustomPlan(true);
    setPlanNotice(`已保存并生效：${formatPlanSummary(plan)}`);
  };

  const handleClearCustomPlan = async () => {
    await updateUserProfile({ customNutritionPlan: undefined });
    setUseCustomPlan(false);
    setPlanCalories("");
    setPlanProtein("");
    setPlanCarbs("");
    setPlanFats("");
    setPlanNotice("已清除自定义方案，恢复按预设公式计算");
  };

  const handleCalculateRecommendation = () => {
    const weight = parseFloat(currentWeight);
    if (!weight || weight <= 0) {
      Alert.alert("提示", "请输入有效的体重");
      return;
    }

    const rec = calculateNutritionRecommendation(state.userProfile, currentGoal, weight, state.userProfile.activityLevel);
    setRecommendation(rec);
  };

  useEffect(() => {
    const weight = parseFloat(currentWeight);
    if (!weight || weight <= 0) return;
    const rec = calculateNutritionRecommendation(state.userProfile, currentGoal, weight, state.userProfile.activityLevel);
    setRecommendation(rec);
  }, [currentWeight, currentGoal, state.userProfile]);

  const handleAddEntry = async () => {
    if (!foodName.trim()) {
      Alert.alert("提示", "请输入食物名称");
      return;
    }

    const caloriesNum = parseFloat(calories) || 0;
    const proteinNum = parseFloat(protein) || 0;
    const carbsNum = parseFloat(carbs) || 0;
    const fatsNum = parseFloat(fats) || 0;
    const quantityNum = parseFloat(quantity) || 0;

    if (!caloriesNum) {
      Alert.alert("提示", "请输入有效的热量");
      return;
    }

    try {
      if (editingItem) {
        const updatedItem: NutritionLogItem = {
          ...editingItem,
          name: foodName.trim(),
          quantity: quantityNum,
          unit: entryUnit,
          calories: caloriesNum,
          protein: proteinNum,
          carbs: carbsNum,
          fats: fatsNum,
          mealType: entryMealType,
          notes: entryNotes.trim() || undefined,
        };
        await updateNutritionEntry(date, updatedItem);
        Alert.alert("成功", "记录已更新");
      } else {
        await addNutritionEntry({
          date,
          foodId: selectedFood?.id,
          name: foodName.trim(),
          quantity: quantityNum,
          unit: entryUnit,
          calories: caloriesNum,
          protein: proteinNum,
          carbs: carbsNum,
          fats: fatsNum,
          source: selectedFood?.source || "quick",
          mealType: entryMealType,
          notes: entryNotes.trim() || undefined,
        });
        Alert.alert("成功", "记录已添加");
      }

      setFoodName("");
      setQuantity("100");
      setCalories("");
      setProtein("");
      setCarbs("");
      setFats("");
      setEntryNotes("");
      setEntryUnit("g");
      setEntryMealType(inferMealType());
      setSelectedFood(null);
      setEditingItem(null);
      setIsAddingEntry(false);
    } catch {
      Alert.alert("错误", "保存失败");
    }
  };

  const handleDeleteItem = (item: NutritionLogItem) => {
    Alert.alert("删除记录", `确定要删除\"${item.name}\"吗？`, [
      { text: "取消", style: "cancel" },
      { text: "删除", style: "destructive", onPress: () => deleteNutritionEntry(date, item.id) },
    ]);
  };

  const handleToggleFavorite = async (foodId: string) => {
    const favorites = state.userProfile.favoriteFoodIds || [];
    const isFavorite = favorites.includes(foodId);
    const next = isFavorite ? favorites.filter((id) => id !== foodId) : [...favorites, foodId];
    await updateUserProfile({ favoriteFoodIds: next });
  };

  // 改克数时按「原记录克数 → 新克数」的比例同步营养数据。
  // 只在编辑已有记录时生效（新增时由食物库每 100g 数据负责折算）。
  const handleQuantityChange = (value: string, forceScale = false) => {
    setQuantity(value);
    if (!editingItem || (!scaleByRatio && !forceScale)) return;
    const base = Number(editingItem.quantity) || 0;
    const next = parseFloat(value);
    if (base <= 0 || !Number.isFinite(next) || next <= 0) return;
    const ratio = next / base;
    const r1 = (n: number) => Math.round(n * 10) / 10;
    setCalories(String(Math.round(editingItem.calories * ratio)));
    setProtein(String(r1(editingItem.protein * ratio)));
    setCarbs(String(r1(editingItem.carbs * ratio)));
    setFats(String(r1(editingItem.fats * ratio)));
  };

  // ── 饮食套餐 ──────────────────────────────────────────────
  const resetComboEditor = () => {
    setComboName("");
    setComboItems([]);
    setEditingCombo(null);
    setComboSearch("");
    setComboDraftFood(null);
    setComboDraftQty("100");
  };

  const handleOpenComboEditor = (combo?: MealCombo) => {
    if (combo) {
      setEditingCombo(combo);
      setComboName(combo.name);
      setComboItems(combo.items.map((item) => ({ ...item })));
    } else {
      resetComboEditor();
    }
    setComboSearch("");
    setComboDraftFood(null);
    setComboDraftQty("100");
    setShowComboModal(true);
  };

  // 最省事的建套餐方式：今天已经记过的那几样，一键变成套餐。
  const handleImportTodayAsCombo = () => {
    const items: MealComboItem[] = (todayEntry?.items || []).map((i) => ({
      foodId: i.foodId,
      name: i.name,
      quantity: i.quantity,
      unit: i.unit,
      calories: i.calories,
      carbs: i.carbs,
      protein: i.protein,
      fats: i.fats,
      source: i.source,
      mealType: i.mealType,
      notes: i.notes,
    }));
    if (!items.length) {
      Alert.alert("提示", "今天还没有饮食记录。先记几样想固定吃的食物，再导入；也可以手动添加食物。");
      return;
    }
    setComboItems(items);
    if (!comboName.trim()) setComboName(`常吃套餐 ${getTodayString().slice(5)}`);
  };

  const handleAddComboDraftItem = () => {
    if (!comboDraftFood) {
      Alert.alert("提示", "请先从搜索结果里选一个食物");
      return;
    }
    const qty = parseFloat(comboDraftQty) || 0;
    if (qty <= 0) {
      Alert.alert("提示", "请输入有效份量（克）");
      return;
    }
    const ratio = qty / 100;
    const r1 = (n: number) => Math.round(n * 10) / 10;
    setComboItems((prev) => [
      ...prev,
      {
        foodId: comboDraftFood.id,
        name: comboDraftFood.name,
        quantity: qty,
        unit: "g",
        calories: Math.round(comboDraftFood.caloriesPer100g * ratio),
        carbs: r1(comboDraftFood.carbsPer100g * ratio),
        protein: r1(comboDraftFood.proteinPer100g * ratio),
        fats: r1(comboDraftFood.fatsPer100g * ratio),
        source: comboDraftFood.source,
        mealType: entryMealType,
      },
    ]);
    setComboDraftFood(null);
    setComboSearch("");
    setComboDraftQty("100");
  };

  const handleSaveCombo = async () => {
    const name = comboName.trim();
    if (!name) {
      Alert.alert("提示", "请输入套餐名称");
      return;
    }
    if (!comboItems.length) {
      Alert.alert("提示", "套餐里至少要有一样食物");
      return;
    }
    try {
      if (editingCombo) {
        await updateMealCombo({ ...editingCombo, name, items: comboItems, updatedAt: new Date().toISOString() });
      } else {
        await addMealCombo({ name, items: comboItems });
      }
      setShowComboModal(false);
      resetComboEditor();
      Alert.alert("成功", "套餐已保存");
    } catch {
      Alert.alert("错误", "保存套餐失败");
    }
  };

  const handleDeleteCombo = (combo: MealCombo) => {
    Alert.alert("删除套餐", `确定删除「${combo.name}」吗？已有饮食记录不会受影响。`, [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: async () => {
          await deleteMealCombo(combo.id);
          setShowComboModal(false);
          resetComboEditor();
        },
      },
    ]);
  };

  const handleApplyCombo = (combo: MealCombo) => {
    if (!combo.items.length) {
      Alert.alert("提示", "这个套餐还没有食物");
      return;
    }
    Alert.alert("添加套餐", `把「${combo.name}」的 ${combo.items.length} 项食物记录到今天？`, [
      { text: "取消", style: "cancel" },
      {
        text: "添加",
        onPress: async () => {
          try {
            for (const item of combo.items) {
              await addNutritionEntry({
                date,
                foodId: item.foodId,
                name: item.name,
                quantity: item.quantity,
                unit: item.unit,
                calories: item.calories,
                carbs: item.carbs,
                protein: item.protein,
                fats: item.fats,
                source: item.source ?? "quick",
                mealType: item.mealType ?? inferMealType(),
                notes: item.notes,
              });
            }
            Alert.alert("成功", `已添加套餐「${combo.name}」共 ${combo.items.length} 项`);
          } catch {
            Alert.alert("错误", "添加套餐失败");
          }
        },
      },
    ]);
  };

  const handleSaveCustomFood = async () => {
    if (!customFoodName.trim()) {
      Alert.alert("提示", "请输入食物名称");
      return;
    }

    const payload = {
      name: customFoodName.trim(),
      category: customCategory,
      caloriesPer100g: parseFloat(customCalories) || 0,
      proteinPer100g: parseFloat(customProtein) || 0,
      carbsPer100g: parseFloat(customCarbs) || 0,
      fatsPer100g: parseFloat(customFats) || 0,
      isCustom: true,
    };

    try {
      if (editingFood) {
        await updateCustomFood({ ...editingFood, ...payload });
      } else {
        await addCustomFood(payload);
      }
      setShowCustomFoodModal(false);
      setCustomFoodName("");
      setCustomCalories("");
      setCustomProtein("");
      setCustomCarbs("");
      setCustomFats("");
      setEditingFood(null);
    } catch {
      Alert.alert("错误", "保存失败");
    }
  };

  const handleDeleteCustomFood = async (food: FoodLibraryItem) => {
    Alert.alert("删除食物", `确定要删除\"${food.name}\"吗？`, [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: async () => {
          await deleteCustomFood(food.id);
          setShowCustomFoodModal(false);
          setEditingFood(null);
        },
      },
    ]);
  };

  const carbToday = activeCarbPlan ? getCarbCycleDay(activeCarbPlan, date) : null;

  const customActive = !!customPlan?.enabled && useCustomPlan && customPlan.calories > 0;

  const dailyTarget = useMemo(() => {
    // 自定义方案优先：AI 给的参数应直接决定每日目标，而不是只显示成一段文字。
    if (customActive && customPlan) {
      return {
        calories: customPlan.calories,
        carbs: customPlan.carbs,
        protein: customPlan.protein,
        fats: customPlan.fats,
      };
    }
    if (carbToday?.day) {
      return {
        calories: carbToday.day.calories,
        carbs: carbToday.day.carbs,
        protein: carbToday.day.protein,
        fats: carbToday.day.fat,
      };
    }
    if (recommendation) {
      return {
        calories: recommendation.dailyCalories,
        carbs: recommendation.carbs.grams,
        protein: recommendation.protein.grams,
        fats: recommendation.fats.grams,
      };
    }
    return null;
  }, [carbToday, recommendation, customActive, customPlan]);

  const recommendedFoods = useMemo(() => {
    if (!recommendation) return [];
    return selectedCategory === "all"
      ? getRecommendedFoods(recommendation.goal)
      : getRecommendedFoods(recommendation.goal, selectedCategory as FoodCategory);
  }, [recommendation, selectedCategory]);

  const handlePlanSave = async () => {
    if (!planName.trim()) {
      Alert.alert("提示", "请输入计划名称");
      return;
    }

    const buildDay = (index: number, type: "high" | "medium" | "low"): CarbCycleDay => {
      const macros = macroByType[type];
      return {
        dayIndex: index + 1,
        type,
        calories: Number(macros.calories) || 0,
        carbs: Number(macros.carbs) || 0,
        protein: Number(macros.protein) || 0,
        fat: Number(macros.fat) || 0,
      };
    };

    const planDays = dayTypes.map((type, index) => buildDay(index, type));

    const payload: Omit<CarbCyclePlan, "id"> = {
      name: planName.trim(),
      cycleLength,
      days: planDays,
      startDate: planStartDate,
    };

    if (activeCarbPlan) {
      await updateCarbCyclePlan({ ...activeCarbPlan, ...payload });
    } else {
      const created = await addCarbCyclePlan(payload);
      await updateUserProfile({ activeCarbCyclePlanId: created.id });
    }

    Alert.alert("成功", "碳水循环计划已保存");
  };

  const handlePlanDelete = async () => {
    if (!activeCarbPlan) return;
    await deleteCarbCyclePlan(activeCarbPlan.id);
    await updateUserProfile({ activeCarbCyclePlanId: undefined });
  };

  useEffect(() => {
    if (!activeCarbPlan) return;
    setPlanName(activeCarbPlan.name);
    setCycleLength(activeCarbPlan.cycleLength);
    setPlanStartDate(activeCarbPlan.startDate || getTodayString());
    setDayTypes(activeCarbPlan.days.map((day) => day.type));
    const initial = {
      high: { calories: "", carbs: "", protein: "", fat: "" },
      medium: { calories: "", carbs: "", protein: "", fat: "" },
      low: { calories: "", carbs: "", protein: "", fat: "" },
    };
    activeCarbPlan.days.forEach((day) => {
      initial[day.type] = {
        calories: String(day.calories),
        carbs: String(day.carbs),
        protein: String(day.protein),
        fat: String(day.fat),
      };
    });
    setMacroByType(initial);
  }, [activeCarbPlan]);

  return (
    <ScreenContainer className="flex-1">
      {/* 头部 */}
      <View className="px-5 pt-6 pb-6 bg-primary/5 rounded-b-[28px]">
        <Text className="text-xs tracking-[2px] text-muted">FITLIFE</Text>
        <Text className="text-2xl font-semibold text-foreground mt-2">饮食</Text>
      </View>

      {/* Tab切换 */}
      <View className="flex-row border-b border-border">
        {[
          { value: "log", label: "饮食记录" },
          { value: "recommend", label: "营养建议" },
          { value: "carb", label: "碳水循环" },
        ].map((tab) => (
          <TouchableOpacity
            key={tab.value}
            onPress={() => setActiveTab(tab.value as typeof activeTab)}
            className={`flex-1 py-4 items-center border-b-2 ${
              activeTab === tab.value ? "border-primary" : "border-transparent"
            }`}
            activeOpacity={0.7}
          >
            <Text className={activeTab === tab.value ? "text-primary font-semibold" : "text-muted"}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* 饮食记录Tab */}
      {activeTab === "log" && (
        <View className="flex-1">
          {/* 今日统计 */}
          <View className="mx-5 mt-4 px-5 py-4 bg-primary/10 rounded-2xl border border-border/70">
            <View className="flex-row items-center justify-between mb-2">
              <Text className="text-foreground font-semibold">今日统计</Text>
              {dailyTarget && (
                <Text className="text-muted text-xs">
                  {customActive ? "自定义" : "目标"} {dailyTarget.calories} kcal
                </Text>
              )}
            </View>
            <View className="flex-row justify-between">
              <View className="items-center">
                <Text className="text-2xl font-bold text-foreground">{todayTotals.calories}</Text>
                <Text className="text-muted text-xs">热量 (kcal)</Text>
              </View>
              <View className="items-center">
                <Text className="text-2xl font-bold text-foreground">{todayTotals.protein.toFixed(1)}</Text>
                <Text className="text-muted text-xs">蛋白质 (g)</Text>
              </View>
              <View className="items-center">
                <Text className="text-2xl font-bold text-foreground">{todayTotals.carbs.toFixed(1)}</Text>
                <Text className="text-muted text-xs">碳水 (g)</Text>
              </View>
              <View className="items-center">
                <Text className="text-2xl font-bold text-foreground">{todayTotals.fats.toFixed(1)}</Text>
                <Text className="text-muted text-xs">脂肪 (g)</Text>
              </View>
            </View>
          </View>

          {/* 饮食套餐：固定吃的那几样，一键整套餐记录 */}
          <View className="px-5 py-4">
            <View className="flex-row items-center justify-between mb-2">
              <Text className="text-foreground font-semibold">饮食套餐</Text>
              <TouchableOpacity onPress={() => handleOpenComboEditor()} activeOpacity={0.7}>
                <Text className="text-primary text-xs">＋ 新建套餐</Text>
              </TouchableOpacity>
            </View>
            {state.mealCombos.length > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {state.mealCombos.map((combo) => {
                  const comboCalories = Math.round(
                    combo.items.reduce((sum, i) => sum + (Number(i.calories) || 0), 0)
                  );
                  return (
                    <TouchableOpacity
                      key={combo.id}
                      onPress={() => handleApplyCombo(combo)}
                      onLongPress={() => handleOpenComboEditor(combo)}
                      className="bg-primary/10 px-3 py-2 rounded-lg border border-primary/30 mr-2"
                      activeOpacity={0.7}
                    >
                      <Text className="text-foreground text-sm font-medium">{combo.name}</Text>
                      <Text className="text-muted text-xs mt-0.5">
                        {combo.items.length} 项 · {comboCalories} kcal
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            ) : (
              <Text className="text-muted text-xs">
                把常吃的一套食物存成套餐，点一下就能整套餐记到当天（长按套餐可编辑）。
              </Text>
            )}
          </View>

          {/* 常用食物 */}
          {favoriteFoods.length > 0 && (
            <View className="px-5 py-4">
              <Text className="text-foreground font-semibold mb-2">常用食物</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {favoriteFoods.map((food) => (
                  <TouchableOpacity
                    key={food.id}
                    onPress={() => {
                      setIsAddingEntry(true);
                      handleSelectFood(food);
                    }}
                    className="bg-surface px-3 py-2 rounded-lg border border-border mr-2"
                    activeOpacity={0.7}
                  >
                    <Text className="text-foreground text-sm">{food.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}

          {/* 添加记录表单 */}
          {isAddingEntry && (
            <View className="px-5 py-4 border-b border-border bg-surface">
              <View className="flex-row items-center justify-between mb-4">
                <Text className="text-foreground font-semibold">{editingItem ? "编辑记录" : "添加记录"}</Text>
                <TouchableOpacity onPress={() => {
                  setIsAddingEntry(false);
                  setEditingItem(null);
                  setSelectedFood(null);
                  setFoodName("");
                  setQuantity("100");
                  setCalories("");
                  setProtein("");
                  setCarbs("");
                  setFats("");
                }}>
                  <IconSymbol name="xmark" size={20} color={colors.muted} />
                </TouchableOpacity>
              </View>

              {/* 食物搜索 */}
              <View className="mb-3">
                <TextInput
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder="搜索食物..."
                  placeholderTextColor={colors.muted}
                  className="bg-background rounded-lg px-3 py-2 text-foreground border border-border"
                />
                {searchQuery.length > 0 && (
                  <View className="mt-2 max-h-40">
                    <FlatList
                      data={filteredFoods}
                      keyExtractor={(item) => item.id}
                      renderItem={({ item }) => (
                        <TouchableOpacity
                          onPress={() => handleSelectFood(item)}
                          onLongPress={() => {
                            if (item.source === "custom") {
                              setEditingFood(item);
                              setCustomFoodName(item.name);
                              setCustomCategory(item.category);
                              setCustomCalories(String(item.caloriesPer100g));
                              setCustomProtein(String(item.proteinPer100g));
                              setCustomCarbs(String(item.carbsPer100g));
                              setCustomFats(String(item.fatsPer100g));
                              setShowCustomFoodModal(true);
                            }
                          }}
                          className="py-2 border-b border-border"
                        >
                          <View className="flex-row items-center justify-between">
                            <Text className="text-foreground">{item.name}</Text>
                            <TouchableOpacity onPress={() => handleToggleFavorite(item.id)}>
                              <IconSymbol
                                name={state.userProfile.favoriteFoodIds?.includes(item.id) ? "star.fill" : "star"}
                                size={18}
                                color={colors.primary}
                              />
                            </TouchableOpacity>
                          </View>
                        </TouchableOpacity>
                      )}
                    />
                  </View>
                )}
              </View>

              <TextInput
                value={foodName}
                onChangeText={setFoodName}
                placeholder="食物名称"
                placeholderTextColor={colors.muted}
                className="bg-background rounded-lg px-3 py-2 text-foreground border border-border mb-3"
              />
              {/* 餐次 / 单位 / 备注：和 AI 记录保持同一套字段，避免记录残缺 */}
              <View className="flex-row items-center gap-2 mb-3 flex-wrap">
                <Text className="text-muted text-sm">餐次</Text>
                {(["breakfast", "lunch", "dinner", "snack"] as MealType[]).map((m) => (
                  <TouchableOpacity
                    key={m}
                    onPress={() => setEntryMealType(m)}
                    className={`px-3 py-1.5 rounded-lg ${entryMealType === m ? "bg-primary" : "bg-background border border-border"}`}
                  >
                    <Text className={entryMealType === m ? "text-background text-xs" : "text-foreground text-xs"}>
                      {MEAL_TYPE_NAMES[m]}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View className="flex-row items-center gap-2 mb-3">
                <Text className="text-muted text-sm">单位</Text>
                {(["g", "ml", "serving"] as const).map((u) => (
                  <TouchableOpacity
                    key={u}
                    onPress={() => setEntryUnit(u)}
                    className={`px-3 py-1.5 rounded-lg ${entryUnit === u ? "bg-primary" : "bg-background border border-border"}`}
                  >
                    <Text className={entryUnit === u ? "text-background text-xs" : "text-foreground text-xs"}>
                      {u === "g" ? "克(g)" : u === "ml" ? "毫升(ml)" : "份"}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TextInput
                value={entryNotes}
                onChangeText={setEntryNotes}
                placeholder="备注（做法、品牌，可留空）"
                placeholderTextColor={colors.muted}
                className="bg-background rounded-lg px-3 py-2 text-foreground border border-border mb-3"
              />
              <View className="flex-row gap-2 mb-3">
                <TextInput
                  value={quantity}
                  onChangeText={handleQuantityChange}
                  placeholder="克数"
                  keyboardType="decimal-pad"
                  placeholderTextColor={colors.muted}
                  className="flex-1 bg-background rounded-lg px-3 py-2 text-foreground border border-border"
                />
                <TextInput
                  value={calories}
                  onChangeText={setCalories}
                  placeholder="热量"
                  keyboardType="decimal-pad"
                  placeholderTextColor={colors.muted}
                  className="flex-1 bg-background rounded-lg px-3 py-2 text-foreground border border-border"
                />
              </View>
              {/* 编辑记录时才出现：改克数时按原记录比例同步热量/宏量 */}
              {editingItem && (
                <TouchableOpacity
                  onPress={() => {
                    const next = !scaleByRatio;
                    setScaleByRatio(next);
                    // 重新打开开关时立刻按当前克数重算一次（此时闭包里的 scaleByRatio 还是旧值）
                    if (next) handleQuantityChange(quantity, true);
                  }}
                  className="flex-row items-center bg-primary/5 rounded-lg px-3 py-2 mb-3 border border-border"
                  activeOpacity={0.7}
                >
                  <View className={`w-5 h-5 rounded items-center justify-center mr-2 ${scaleByRatio ? "bg-primary" : "bg-background border border-border"}`}>
                    {scaleByRatio ? <Text className="text-background text-xs font-bold">✓</Text> : null}
                  </View>
                  <View className="flex-1">
                    <Text className="text-foreground text-sm">按原记录比例调整营养数据</Text>
                    <Text className="text-muted text-xs mt-0.5">
                      原 {editingItem.quantity}{editingItem.unit === "serving" ? "份" : editingItem.unit || "g"} · {editingItem.calories} kcal · 蛋白 {editingItem.protein}g / 碳水 {editingItem.carbs}g / 脂肪 {editingItem.fats}g
                    </Text>
                  </View>
                </TouchableOpacity>
              )}
              <View className="flex-row gap-2 mb-3">
                <TextInput
                  value={protein}
                  onChangeText={setProtein}
                  placeholder="蛋白(g)"
                  keyboardType="decimal-pad"
                  placeholderTextColor={colors.muted}
                  className="flex-1 bg-background rounded-lg px-3 py-2 text-foreground border border-border"
                />
                <TextInput
                  value={carbs}
                  onChangeText={setCarbs}
                  placeholder="碳水(g)"
                  keyboardType="decimal-pad"
                  placeholderTextColor={colors.muted}
                  className="flex-1 bg-background rounded-lg px-3 py-2 text-foreground border border-border"
                />
              </View>
              <View className="flex-row gap-2 mb-3">
                <TextInput
                  value={fats}
                  onChangeText={setFats}
                  placeholder="脂肪(g)"
                  keyboardType="decimal-pad"
                  placeholderTextColor={colors.muted}
                  className="flex-1 bg-background rounded-lg px-3 py-2 text-foreground border border-border"
                />
                <TouchableOpacity
                  onPress={() => {
                    setShowCustomFoodModal(true);
                    setEditingFood(null);
                    setCustomFoodName("");
                    setCustomCalories("");
                    setCustomProtein("");
                    setCustomCarbs("");
                    setCustomFats("");
                  }}
                  className="flex-1 bg-muted/20 rounded-lg items-center justify-center"
                >
                  <Text className="text-foreground">添加自定义食物</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity onPress={handleAddEntry} className="bg-primary rounded-lg py-2 items-center">
                <Text className="text-background font-semibold">保存</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* 记录列表：早 / 中 / 晚三段分开，各自带小计 */}
          <SectionList
            sections={mealSections}
            keyExtractor={(item) => item.id}
            stickySectionHeadersEnabled={false}
            renderSectionHeader={({ section }) => (
              <View className="px-5 pt-4 pb-2 flex-row items-center justify-between">
                <View className="flex-row items-center">
                  <View className="w-1 h-4 rounded-full bg-primary mr-2" />
                  <Text className="text-foreground font-semibold">{section.title}</Text>
                  <Text className="text-muted text-xs ml-2">{section.data.length} 项</Text>
                </View>
                <Text className="text-primary text-xs font-semibold">{section.totalCalories} kcal</Text>
              </View>
            )}
            renderSectionFooter={({ section }) =>
              section.data.length === 0 && !isAddingEntry ? (
                <View className="mx-5 py-3 rounded-xl border border-dashed border-border items-center">
                  <Text className="text-muted text-xs">暂无记录</Text>
                </View>
              ) : null
            }
            renderItem={({ item }) => (
              <TouchableOpacity
                onPress={() => {
                  setEditingItem(item);
                  setScaleByRatio(true);
                  setSelectedFood(null);
                  setFoodName(item.name);
                  setQuantity(String(item.quantity));
                  setCalories(String(item.calories));
                  setProtein(String(item.protein));
                  setCarbs(String(item.carbs));
                  setFats(String(item.fats));
                  setEntryUnit(item.unit || "g");
                  setEntryMealType(item.mealType || inferMealType());
                  setEntryNotes(item.notes || "");
                  setIsAddingEntry(true);
                }}
                onLongPress={() => handleDeleteItem(item)}
                className="mx-5 px-3 py-3 mb-2 bg-surface rounded-xl border border-border"
                activeOpacity={0.7}
              >
                <View className="flex-row items-center justify-between">
                  <View className="flex-1">
                    <Text className="text-foreground font-medium">{item.name}</Text>
                    <Text className="text-muted text-sm">
                      {item.quantity}{item.unit === "serving" ? "份" : item.unit || "g"} · {item.calories} kcal · 蛋白 {item.protein}g / 碳水 {item.carbs}g / 脂肪 {item.fats}g
                    </Text>
                    {item.notes ? (
                      <Text className="text-muted text-xs mt-1" numberOfLines={1}>{item.notes}</Text>
                    ) : null}
                  </View>
                  <Text className="text-primary font-semibold ml-3">{item.calories}</Text>
                </View>
              </TouchableOpacity>
            )}
            contentContainerStyle={{ paddingBottom: 100 }}
          />

          {/* 添加按钮 */}
          {!isAddingEntry && (
            <TouchableOpacity
              onPress={() => setIsAddingEntry(true)}
              className="absolute bottom-6 right-6 w-14 h-14 bg-primary rounded-full items-center justify-center shadow-lg"
              activeOpacity={0.8}
            >
              <IconSymbol name="plus" size={24} color={colors.background} />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* 营养建议Tab */}
      {activeTab === "recommend" && (
        <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 100 }}>
          <View className="px-5 py-4">
            {/* 目标选择：三个预设 + 自定义（AI 营养建议落点） */}
            <Text className="text-foreground font-semibold mb-3">训练目标</Text>
            <View className="flex-row gap-2 mb-4">
              {[
                ...(Object.keys(NUTRITION_GOAL_NAMES) as NutritionGoal[]).map((goal) => ({
                  key: goal as string,
                  label: NUTRITION_GOAL_NAMES[goal],
                  value: goal as NutritionGoal | "custom",
                })),
                { key: "custom", label: "自定义", value: "custom" as const },
              ].map((option) => {
                const selected = useCustomPlan
                  ? option.value === "custom"
                  : currentGoal === option.value;
                return (
                  <TouchableOpacity
                    key={option.key}
                    onPress={() => handleSelectGoal(option.value)}
                    className={`flex-1 py-3 rounded-lg items-center ${
                      selected ? "bg-primary" : "bg-surface border border-border"
                    }`}
                    activeOpacity={0.7}
                  >
                    <Text className={`text-xs ${selected ? "text-background font-semibold" : "text-foreground"}`}>
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* 自定义营养方案：AI 建议写入这里，可手改、清除、跳去 AI 重新生成 */}
            {useCustomPlan && (
              <View className="bg-primary/10 rounded-xl p-4 mb-4 border border-border">
                <View className="flex-row items-center justify-between mb-2">
                  <Text className="text-foreground font-semibold">自定义营养方案</Text>
                  <Text className="text-primary text-xs">
                    {customPlan?.source === "ai" ? "AI 建议" : "手动"}
                    {customPlan?.enabled ? " · 已生效" : ""}
                  </Text>
                </View>
                <Text className="text-muted text-xs mb-3 leading-5">
                  AI 给出的营养参数会存到这里，并直接作为「今日统计」的每日目标；数值可随时改。
                </Text>
                {customPlan?.note ? (
                  <Text className="text-muted text-xs mb-2" numberOfLines={2}>{customPlan.note}</Text>
                ) : null}
                {customPlan ? (
                  <Text className="text-muted text-xs mb-3">
                    更新于 {new Date(customPlan.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </Text>
                ) : null}

                <View className="flex-row gap-2 mb-2">
                  <TextInput
                    value={planCalories}
                    onChangeText={setPlanCalories}
                    placeholder="热量 kcal"
                    keyboardType="decimal-pad"
                    placeholderTextColor={colors.muted}
                    className="flex-1 bg-background rounded-lg px-3 py-2 text-foreground border border-border"
                  />
                  <TextInput
                    value={planProtein}
                    onChangeText={setPlanProtein}
                    placeholder="蛋白 g"
                    keyboardType="decimal-pad"
                    placeholderTextColor={colors.muted}
                    className="flex-1 bg-background rounded-lg px-3 py-2 text-foreground border border-border"
                  />
                </View>
                <View className="flex-row gap-2 mb-3">
                  <TextInput
                    value={planCarbs}
                    onChangeText={setPlanCarbs}
                    placeholder="碳水 g"
                    keyboardType="decimal-pad"
                    placeholderTextColor={colors.muted}
                    className="flex-1 bg-background rounded-lg px-3 py-2 text-foreground border border-border"
                  />
                  <TextInput
                    value={planFats}
                    onChangeText={setPlanFats}
                    placeholder="脂肪 g"
                    keyboardType="decimal-pad"
                    placeholderTextColor={colors.muted}
                    className="flex-1 bg-background rounded-lg px-3 py-2 text-foreground border border-border"
                  />
                </View>

                {customActive && customPlan ? (
                  <View className="mb-3">
                    <Text className="text-foreground text-sm font-medium mb-1">
                      当前目标：{formatPlanSummary(customPlan)}
                    </Text>
                    <Text className="text-muted text-xs">
                      供能占比 蛋白 {macroPercentages(customPlan).protein}% · 碳水 {macroPercentages(customPlan).carbs}% · 脂肪 {macroPercentages(customPlan).fats}%
                    </Text>
                  </View>
                ) : null}

                <View className="flex-row gap-2">
                  <TouchableOpacity
                    onPress={handleSaveCustomPlan}
                    className="flex-1 bg-primary rounded-lg py-2 items-center"
                    activeOpacity={0.8}
                  >
                    <Text className="text-background font-semibold text-sm">保存并生效</Text>
                  </TouchableOpacity>
                  {customPlan && (
                    <TouchableOpacity
                      onPress={handleClearCustomPlan}
                      className="bg-error/10 rounded-lg px-3 items-center justify-center"
                      activeOpacity={0.8}
                    >
                      <Text className="text-error text-sm">清除</Text>
                    </TouchableOpacity>
                  )}
                </View>
                {planNotice ? (
                  <Text className="text-primary text-xs mt-2 leading-5">{planNotice}</Text>
                ) : null}
                <TouchableOpacity
                  onPress={() => router.push("/profile/ai")}
                  className="mt-3 self-start"
                  activeOpacity={0.7}
                >
                  <Text className="text-primary text-xs">去 AI 助手生成一套营养参数建议 →</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* 体重输入 */}
            <Text className="text-foreground font-semibold mb-2">当前体重 (kg)</Text>
            <View className="flex-row gap-2 mb-4">
              <TextInput
                value={currentWeight}
                onChangeText={setCurrentWeight}
                keyboardType="decimal-pad"
                placeholder="输入体重"
                placeholderTextColor={colors.muted}
                className="flex-1 bg-surface rounded-lg px-4 py-3 text-foreground border border-border"
              />
              <TouchableOpacity
                onPress={handleCalculateRecommendation}
                className="bg-primary rounded-lg px-6 items-center justify-center"
                activeOpacity={0.8}
              >
                <Text className="text-background font-semibold">计算</Text>
              </TouchableOpacity>
            </View>

            {/* 推荐结果（自定义模式下不生效，隐藏以免误读） */}
            {recommendation && !useCustomPlan && (
              <View className="bg-primary/10 rounded-xl p-4 mb-4">
                <Text className="text-foreground font-semibold mb-4">营养推荐</Text>
                <View className="gap-3">
                  <View className="flex-row items-center justify-between">
                    <Text className="text-foreground">每日热量</Text>
                    <Text className="text-primary font-bold text-lg">{recommendation.dailyCalories} kcal</Text>
                  </View>
                  <View className="flex-row items-center justify-between">
                    <Text className="text-foreground">蛋白质</Text>
                    <Text className="text-foreground">{recommendation.protein.grams}g ({recommendation.protein.percentage}%)</Text>
                  </View>
                  <View className="flex-row items-center justify-between">
                    <Text className="text-foreground">碳水化合物</Text>
                    <Text className="text-foreground">{recommendation.carbs.grams}g ({recommendation.carbs.percentage}%)</Text>
                  </View>
                  <View className="flex-row items-center justify-between">
                    <Text className="text-foreground">脂肪</Text>
                    <Text className="text-foreground">{recommendation.fats.grams}g ({recommendation.fats.percentage}%)</Text>
                  </View>
                </View>
              </View>
            )}

            {/* 推荐食物 */}
            {recommendation && (
              <View>
                <Text className="text-foreground font-semibold mb-3">推荐食物</Text>
                <View className="flex-row flex-wrap gap-2 mb-4">
                  {([
                    { value: "all" as const, label: "全部" },
                    { value: "protein" as const, label: "蛋白质" },
                    { value: "carbs" as const, label: "碳水" },
                    { value: "fats" as const, label: "脂肪" },
                  ]).map((option) => (
                    <TouchableOpacity
                      key={option.value}
                      onPress={() => setSelectedCategory(option.value)}
                      className={`px-4 py-2 rounded-lg ${
                        selectedCategory === option.value ? "bg-primary" : "bg-surface border border-border"
                      }`}
                      activeOpacity={0.7}
                    >
                      <Text className={selectedCategory === option.value ? "text-background text-sm font-semibold" : "text-foreground text-sm"}>
                        {option.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <FlatList
                  scrollEnabled={false}
                  data={recommendedFoods}
                  keyExtractor={(item) => item.id}
                  renderItem={({ item }) => (
                    <View className="bg-surface rounded-lg p-3 mb-2 border border-border">
                      <Text className="text-foreground font-medium">{item.name}</Text>
                      <Text className="text-muted text-sm">热量: {item.caloriesPer100g} kcal | 蛋白: {item.proteinPer100g}g</Text>
                    </View>
                  )}
                />
              </View>
            )}
          </View>
        </ScrollView>
      )}

      {/* 碳水循环Tab */}
      {activeTab === "carb" && (
        <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 120 }}>
          <View className="px-5 py-4">
            <Text className="text-foreground font-semibold mb-3">碳水循环计划</Text>
            <Text className="text-muted text-sm mb-4">设置高/中/低碳日的周期与宏量营养素目标。</Text>

            <View className="bg-surface rounded-xl p-4 border border-border mb-4">
              <TextInput
                value={planName}
                onChangeText={setPlanName}
                placeholder="计划名称"
                placeholderTextColor={colors.muted}
                className="bg-background rounded-lg px-3 py-2 text-foreground border border-border mb-3"
              />
              <View className="flex-row gap-2 mb-3">
                <TextInput
                  value={String(cycleLength)}
                  onChangeText={(value) => {
                    const length = Math.max(3, Math.min(14, Number(value) || 7));
                    setCycleLength(length);
                    setDayTypes((prev) => {
                      const next = Array.from({ length }, (_, index) => prev[index] || "medium");
                      return next;
                    });
                  }}
                  keyboardType="number-pad"
                  placeholder="周期长度(天)"
                  placeholderTextColor={colors.muted}
                  className="flex-1 bg-background rounded-lg px-3 py-2 text-foreground border border-border"
                />
                <TextInput
                  value={planStartDate}
                  onChangeText={setPlanStartDate}
                  placeholder="开始日期"
                  placeholderTextColor={colors.muted}
                  className="flex-1 bg-background rounded-lg px-3 py-2 text-foreground border border-border"
                />
              </View>

              <Text className="text-foreground font-medium mb-2">每日类型</Text>
              <View className="flex-row flex-wrap gap-2 mb-4">
                {dayTypes.map((type, index) => (
                  <TouchableOpacity
                    key={`${type}-${index}`}
                    onPress={() => {
                      setDayTypes((prev) => prev.map((item, idx) => {
                        if (idx !== index) return item;
                        if (item === "high") return "medium";
                        if (item === "medium") return "low";
                        return "high";
                      }));
                    }}
                    className="px-3 py-2 rounded-lg border border-border bg-background"
                  >
                    <Text className="text-foreground text-sm">第 {index + 1} 天 · {CARB_DAY_NAMES[type]}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {(["high", "medium", "low"] as const).map((type) => (
                <View key={type} className="mb-3">
                  <Text className="text-foreground font-medium mb-2">{CARB_DAY_NAMES[type]} 宏量</Text>
                  <View className="flex-row gap-2 mb-2">
                    <TextInput
                      value={macroByType[type].calories}
                      onChangeText={(value) => setMacroByType((prev) => ({ ...prev, [type]: { ...prev[type], calories: value } }))}
                      placeholder="热量"
                      keyboardType="number-pad"
                      placeholderTextColor={colors.muted}
                      className="flex-1 bg-background rounded-lg px-3 py-2 text-foreground border border-border"
                    />
                    <TextInput
                      value={macroByType[type].carbs}
                      onChangeText={(value) => setMacroByType((prev) => ({ ...prev, [type]: { ...prev[type], carbs: value } }))}
                      placeholder="碳水"
                      keyboardType="number-pad"
                      placeholderTextColor={colors.muted}
                      className="flex-1 bg-background rounded-lg px-3 py-2 text-foreground border border-border"
                    />
                  </View>
                  <View className="flex-row gap-2">
                    <TextInput
                      value={macroByType[type].protein}
                      onChangeText={(value) => setMacroByType((prev) => ({ ...prev, [type]: { ...prev[type], protein: value } }))}
                      placeholder="蛋白"
                      keyboardType="number-pad"
                      placeholderTextColor={colors.muted}
                      className="flex-1 bg-background rounded-lg px-3 py-2 text-foreground border border-border"
                    />
                    <TextInput
                      value={macroByType[type].fat}
                      onChangeText={(value) => setMacroByType((prev) => ({ ...prev, [type]: { ...prev[type], fat: value } }))}
                      placeholder="脂肪"
                      keyboardType="number-pad"
                      placeholderTextColor={colors.muted}
                      className="flex-1 bg-background rounded-lg px-3 py-2 text-foreground border border-border"
                    />
                  </View>
                </View>
              ))}
            </View>

            <View className="flex-row gap-3">
              {activeCarbPlan && (
                <TouchableOpacity
                  onPress={() => updateUserProfile({ activeCarbCyclePlanId: undefined })}
                  className="flex-1 bg-muted/20 rounded-xl py-3 items-center"
                >
                  <Text className="text-foreground">停用计划</Text>
                </TouchableOpacity>
              )}
              {activeCarbPlan && (
                <TouchableOpacity onPress={handlePlanDelete} className="flex-1 bg-error/10 rounded-xl py-3 items-center">
                  <Text className="text-error">删除计划</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={handlePlanSave} className="flex-1 bg-primary rounded-xl py-3 items-center">
                <Text className="text-background font-semibold">保存计划</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      )}

      {/* 饮食套餐编辑弹窗 */}
      <Modal visible={showComboModal} animationType="slide" presentationStyle="pageSheet">
        <ScreenContainer className="flex-1">
          <View className="flex-row items-center justify-between px-5 py-4 border-b border-border">
            <TouchableOpacity onPress={() => { setShowComboModal(false); resetComboEditor(); }}>
              <Text className="text-primary">取消</Text>
            </TouchableOpacity>
            <Text className="text-lg font-semibold text-foreground">{editingCombo ? "编辑套餐" : "新建套餐"}</Text>
            <TouchableOpacity onPress={handleSaveCombo}>
              <Text className="text-primary font-semibold">保存</Text>
            </TouchableOpacity>
          </View>

          <ScrollView className="flex-1" contentContainerStyle={{ padding: 20 }}>
            <Text className="text-muted text-xs mb-2">
              把固定会吃的食物存成一套，之后在饮食记录页点套餐名就能一次全记进去。
            </Text>
            <TextInput
              value={comboName}
              onChangeText={setComboName}
              placeholder="套餐名称，如 早餐固定搭配"
              placeholderTextColor={colors.muted}
              className="bg-surface rounded-lg px-4 py-3 text-foreground border border-border mb-3"
            />
            <TouchableOpacity
              onPress={handleImportTodayAsCombo}
              className="bg-primary/10 rounded-lg py-3 items-center mb-5 border border-border"
              activeOpacity={0.8}
            >
              <Text className="text-primary font-medium">从今日记录导入（把今天吃的存成套餐）</Text>
            </TouchableOpacity>

            <Text className="text-foreground font-semibold mb-2">套餐内容（{comboItems.length} 项）</Text>
            {comboItems.length > 0 ? (
              <View className="mb-5">
                {comboItems.map((item, index) => (
                  <View key={`${item.name}-${index}`} className="flex-row items-center bg-surface rounded-lg px-3 py-2 mb-2 border border-border">
                    <View className="flex-1">
                      <Text className="text-foreground">{item.name}</Text>
                      <Text className="text-muted text-xs mt-0.5">
                        {item.quantity}{item.unit === "serving" ? "份" : item.unit} · {item.calories} kcal · 蛋白 {item.protein}g / 碳水 {item.carbs}g / 脂肪 {item.fats}g
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => setComboItems((prev) => prev.filter((_, i) => i !== index))}
                      className="ml-2 px-2 py-1"
                    >
                      <Text className="text-error">移除</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            ) : (
              <Text className="text-muted text-xs mb-5">还没有食物，可以从今天记录导入，或在下面搜索添加。</Text>
            )}

            <Text className="text-foreground font-semibold mb-2">添加食物</Text>
            <TextInput
              value={comboSearch}
              onChangeText={(text) => { setComboSearch(text); setComboDraftFood(null); }}
              placeholder="搜索食物名..."
              placeholderTextColor={colors.muted}
              className="bg-surface rounded-lg px-4 py-3 text-foreground border border-border mb-2"
            />
            {comboDraftFood ? (
              <View className="bg-primary/5 rounded-lg p-3 mb-4 border border-border">
                <Text className="text-foreground font-medium mb-2">已选：{comboDraftFood.name}（每 100g {comboDraftFood.caloriesPer100g} kcal）</Text>
                <View className="flex-row gap-2">
                  <TextInput
                    value={comboDraftQty}
                    onChangeText={setComboDraftQty}
                    placeholder="克数"
                    keyboardType="decimal-pad"
                    placeholderTextColor={colors.muted}
                    className="flex-1 bg-background rounded-lg px-3 py-2 text-foreground border border-border"
                  />
                  <TouchableOpacity
                    onPress={handleAddComboDraftItem}
                    className="bg-primary rounded-lg px-5 items-center justify-center"
                    activeOpacity={0.8}
                  >
                    <Text className="text-background font-semibold">加入套餐</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : comboFilteredFoods.length > 0 ? (
              <View className="mb-4">
                {comboFilteredFoods.map((food) => (
                  <TouchableOpacity
                    key={food.id}
                    onPress={() => setComboDraftFood(food)}
                    className="py-2 border-b border-border"
                    activeOpacity={0.7}
                  >
                    <Text className="text-foreground">
                      {food.name} · {food.caloriesPer100g} kcal/100g
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}

            {editingCombo && (
              <TouchableOpacity
                onPress={() => handleDeleteCombo(editingCombo)}
                className="mt-2 bg-error/10 rounded-lg py-3 items-center"
                activeOpacity={0.8}
              >
                <Text className="text-error">删除这个套餐</Text>
              </TouchableOpacity>
            )}
          </ScrollView>
        </ScreenContainer>
      </Modal>

      {/* 自定义食物弹窗 */}
      <Modal visible={showCustomFoodModal} animationType="slide" presentationStyle="pageSheet">
        <ScreenContainer className="flex-1">
          <View className="flex-row items-center justify-between px-5 py-4 border-b border-border">
            <TouchableOpacity onPress={() => { setShowCustomFoodModal(false); setEditingFood(null); }}>
              <Text className="text-primary">取消</Text>
            </TouchableOpacity>
            <Text className="text-lg font-semibold text-foreground">{editingFood ? "编辑食物" : "添加自定义食物"}</Text>
            <TouchableOpacity onPress={handleSaveCustomFood}>
              <Text className="text-primary font-semibold">保存</Text>
            </TouchableOpacity>
          </View>

          <ScrollView className="flex-1" contentContainerStyle={{ padding: 20 }}>
            <TextInput
              value={customFoodName}
              onChangeText={setCustomFoodName}
              placeholder="食物名称"
              placeholderTextColor={colors.muted}
              className="bg-surface rounded-lg px-4 py-3 text-foreground border border-border mb-3"
            />
            <View className="flex-row flex-wrap gap-2 mb-3">
              {FOOD_CATEGORIES.map((category) => (
                <TouchableOpacity
                  key={category}
                  onPress={() => setCustomCategory(category)}
                  className={`px-3 py-2 rounded-lg ${
                    customCategory === category ? "bg-primary" : "bg-surface border border-border"
                  }`}
                >
                  <Text className={customCategory === category ? "text-background" : "text-foreground"}>{category}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View className="flex-row gap-2 mb-3">
              <TextInput
                value={customCalories}
                onChangeText={setCustomCalories}
                placeholder="热量/100g"
                keyboardType="decimal-pad"
                placeholderTextColor={colors.muted}
                className="flex-1 bg-surface rounded-lg px-4 py-3 text-foreground border border-border"
              />
              <TextInput
                value={customProtein}
                onChangeText={setCustomProtein}
                placeholder="蛋白/100g"
                keyboardType="decimal-pad"
                placeholderTextColor={colors.muted}
                className="flex-1 bg-surface rounded-lg px-4 py-3 text-foreground border border-border"
              />
            </View>
            <View className="flex-row gap-2">
              <TextInput
                value={customCarbs}
                onChangeText={setCustomCarbs}
                placeholder="碳水/100g"
                keyboardType="decimal-pad"
                placeholderTextColor={colors.muted}
                className="flex-1 bg-surface rounded-lg px-4 py-3 text-foreground border border-border"
              />
              <TextInput
                value={customFats}
                onChangeText={setCustomFats}
                placeholder="脂肪/100g"
                keyboardType="decimal-pad"
                placeholderTextColor={colors.muted}
                className="flex-1 bg-surface rounded-lg px-4 py-3 text-foreground border border-border"
              />
            </View>

            {editingFood && (
              <TouchableOpacity
                onPress={() => handleDeleteCustomFood(editingFood)}
                className="mt-4 bg-error/10 rounded-lg py-3 items-center"
              >
                <Text className="text-error">删除食物</Text>
              </TouchableOpacity>
            )}
          </ScrollView>
        </ScreenContainer>
      </Modal>
    </ScreenContainer>
  );
}
