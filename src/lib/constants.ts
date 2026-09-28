// src/lib/constants.ts
import type { Category, Currency, Theme } from "./types";

// 🔥 Версия приложения
// Подставляется из package.json на этапе сборки (vite.config.ts), поэтому
// источник правды ровно один: раньше версия была ещё и строкой в этом файле,
// и установщик с экраном настроек показывали разные значения. Значение
// ниже — запасной вариант для dev-сервера и окружений без подстановки.
export const APP_VERSION: string = import.meta.env.VITE_APP_VERSION || "1.0.0-beta.1";
export const STORAGE_KEY = "nexus.data.v1";

export const CATEGORIES: Category[] = [
  { id: "salary", label: "Зарплата", type: "income", color: "#00FF87", icon: "briefcase" },
  { id: "freelance", label: "Фриланс", type: "income", color: "#00D4FF", icon: "laptop" },
  { id: "invest_in", label: "Дивиденды", type: "income", color: "#FFB800", icon: "trending" },
  { id: "gifts", label: "Подарки", type: "income", color: "#FF2D78", icon: "gift" },
  { id: "other_in", label: "Прочий доход", type: "income", color: "#8A8FA8", icon: "plus" },
  { id: "groceries", label: "Продукты", type: "expense", color: "#00FF87", icon: "cart" },
  { id: "cafe", label: "Кафе и рестораны", type: "expense", color: "#FFB800", icon: "utensils" },
  { id: "transport", label: "Транспорт", type: "expense", color: "#00D4FF", icon: "bus" },
  { id: "housing", label: "Жильё и ЖКХ", type: "expense", color: "#7C5CFF", icon: "home" },
  { id: "subs", label: "Подписки", type: "expense", color: "#FF2D78", icon: "repeat" },
  { id: "fun", label: "Развлечения", type: "expense", color: "#FF6B35", icon: "gamepad" },
  { id: "health", label: "Здоровье", type: "expense", color: "#FF4D6D", icon: "pulse" },
  { id: "shopping", label: "Покупки", type: "expense", color: "#4DA6FF", icon: "bag" },
  { id: "education", label: "Образование", type: "expense", color: "#9D6BFF", icon: "grad" },
  { id: "travel", label: "Путешествия", type: "expense", color: "#2DD4BF", icon: "plane" },
  { id: "savings", label: "Цели и накопления", type: "expense", color: "#00D4FF", icon: "piggy" },
  { id: "other_exp", label: "Прочий расход", type: "expense", color: "#8A8FA8", icon: "dots" },
];

export const categoryById = (id: string): Category =>
  CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[CATEGORIES.length - 1];

export const CURRENCIES: Record<Currency, { symbol: string; label: string }> = {
  RUB: { symbol: "₽", label: "Российский рубль" },
  USD: { symbol: "$", label: "Доллар США" },
  EUR: { symbol: "€", label: "Евро" },
  GBP: { symbol: "£", label: "Фунт стерлингов" },
};

export const THEMES: { id: Theme; label: string; desc: string; swatch: string[] }[] = [
  { id: "cyberpunk", label: "Cyberpunk", desc: "Неон, стекло, свечение", swatch: ["#0A0B0E", "#00D4FF", "#FF2D78", "#00FF87"] },
  { id: "dark", label: "Dark Minimal", desc: "Тёмный минимализм", swatch: ["#0E1014", "#6366F1", "#22C55E", "#E8EAF0"] },
  { id: "light", label: "Light Minimal", desc: "Светлый и чистый", swatch: ["#F5F7FA", "#007AFF", "#34C759", "#1A1A2E"] },
];

export const FONT_SCALES = [
  { value: 1, label: "100%" },
  { value: 1.15, label: "115%" },
  { value: 1.3, label: "130%" },
];

export const SOURCE_LABELS: Record<string, string> = {
  manual: "Ручная",
  subscription: "Подписка",
  payment: "Платёж",
  goal: "Цель",
};

export const PAGE_SIZE = 12;