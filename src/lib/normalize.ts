// src/lib/normalize.ts
// Нормализация документа данных: приводит любой источник (localStorage,
// импорт файла, SQLite) к валидному AppData. Вынесено отдельно от
// storage.ts, чтобы слой хранения не зависел от UI-слоя.
import { emptyData } from "./engine";
import type { AppData, Currency, Theme } from "./types";

export const COLLECTIONS = [
  "transactions", "subscriptions", "fixedPayments", "budgets",
  "goals", "investments", "pendingPayments", "skippedPayments",
] as const;

const THEMES: Theme[] = ["cyberpunk", "dark", "light"];
const CURRENCIES: Currency[] = ["RUB", "USD", "EUR", "GBP"];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export function normalizeAppData(raw: unknown): AppData | null {
  if (!isRecord(raw)) return null;
  // Раньше требовался массив transactions, и документ вроде
  // { subscriptions: [...] } целиком отбраковывался — терялись подписки
  // и цели. Достаточно, чтобы был хотя бы один узнаваемый ключ данных.
  const hasAnyCollection = COLLECTIONS.some((key) => Array.isArray(raw[key]));
  const hasSettings =
    typeof raw.currency === "string" || typeof raw.theme === "string" || typeof raw.fontScale === "number";
  if (!hasAnyCollection && !hasSettings) return null;

  const base = emptyData();
  const out: Record<string, unknown> = { ...base };

  for (const key of COLLECTIONS) {
    const value = raw[key];
    out[key] = Array.isArray(value)
      ? value.filter((x) => isRecord(x) && typeof x.id === "string" && x.id.length > 0)
      : [];
  }
  // skippedPayments необязателен в типе — гарантируем массив
  out.skippedPayments = Array.isArray(out.skippedPayments) ? out.skippedPayments : [];

  out.currency = typeof raw.currency === "string" && CURRENCIES.includes(raw.currency as Currency)
    ? (raw.currency as Currency)
    : base.currency;
  out.theme = typeof raw.theme === "string" && THEMES.includes(raw.theme as Theme)
    ? (raw.theme as Theme)
    : base.theme;
  out.fontScale =
    typeof raw.fontScale === "number" && raw.fontScale >= 0.8 && raw.fontScale <= 1.6
      ? raw.fontScale
      : 1;

  return out as unknown as AppData;
}

/** Слияние документов: записи из incoming приоритетнее, из base — дописываются. */
export function mergeAppData(base: AppData, incoming: AppData): AppData {
  const merged = { ...incoming } as Record<string, unknown>;
  for (const key of COLLECTIONS) {
    const a = (base[key] ?? []) as { id: string }[];
    const b = (incoming[key] ?? []) as { id: string }[];
    // Без id записи не различаются: все undefined схлопывались в одну.
    const seen = new Set(b.filter((x) => typeof x?.id === "string").map((x) => x.id));
    merged[key] = [...b, ...a.filter((x) => typeof x?.id === "string" && !seen.has(x.id))];
  }
  // Настройки берём из incoming, но если их там нет — не теряем базовые.
  for (const key of ["currency", "theme", "fontScale"] as const) {
    if (merged[key] === undefined) merged[key] = base[key];
  }
  return merged as unknown as AppData;
}

/** true, если в документе нет ни одной записи и настройки дефолтные. */
export function isEmptyAppData(data: AppData | null): boolean {
  if (!data) return true;
  const hasRecords = COLLECTIONS.some((key) => (data[key] ?? []).length > 0);
  return !hasRecords;
}

/** Гарантирует наличие skippedPayments перед сохранением. */
export function withCompleteShape(data: AppData): AppData {
  return { ...data, skippedPayments: data.skippedPayments ?? [] };
}
