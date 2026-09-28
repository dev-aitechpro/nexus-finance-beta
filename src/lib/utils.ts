import { CURRENCIES } from "./constants";
import type { Currency } from "./types";

let counter = 0;
export const uid = (): string =>
  `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const pad = (n: number) => String(n).padStart(2, "0");

export const toISO = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const parseISO = (s: string): Date => new Date(`${s}T00:00:00`);

export const todayISO = (): string => toISO(new Date());

export const startOfDay = (d: Date): Date => {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
};

export const addDays = (d: Date, n: number): Date => {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
};

export const addMonths = (d: Date, n: number): Date => {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
};

export const monthKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

export const daysInMonth = (year: number, monthIdx: number): number =>
  new Date(year, monthIdx + 1, 0).getDate();

/** Дата с ограничением дня (31 февраля → 28/29) */
export const clampedDate = (year: number, monthIdx: number, day: number): Date =>
  new Date(year, monthIdx, Math.min(day, daysInMonth(year, monthIdx)));

export const daysUntil = (iso: string): number => {
  const diff = parseISO(iso).getTime() - startOfDay(new Date()).getTime();
  return Math.round(diff / 86400000);
};

const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MONTHS_FULL = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

export const formatDate = (iso: string): string => {
  const d = parseISO(iso);
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
};

export const formatDateShort = (iso: string): string => {
  const d = parseISO(iso);
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
};

export const monthLabel = (d: Date): string => MONTHS_SHORT[d.getMonth()];
export const monthFull = (d: Date): string => MONTHS_FULL[d.getMonth()];

export const currentMonthLabel = (): string => {
  const d = new Date();
  return `${MONTHS_FULL[d.getMonth()]} ${d.getFullYear()}`;
};

export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const d = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (d > 1 && d < 5) return few;
  if (d === 1) return one;
  return many;
}

/** Парсинг суммы: "12 345,67" → 12345.67 */
export function parseAmount(raw: string): number {
  const cleaned = raw.replace(/\s|₽|\$|€|£|руб\.?/gi, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * Умеет ли шрифт нарисовать символ.
 *
 * Зачем: на реальном телефоне (Infinix X6858, Android 16) знак рубля ₽
 * (U+20BD) в системном шрифте отсутствует, и WebView рисует вместо него
 * «плашку» — суммы выглядят как 557 885 ▯. Intl.NumberFormat подставляет
 * символ сам, поэтому проверять приходится после форматирования.
 *
 * Проверка стандартная: сравниваем ширину символа с шириной заведомо
 * отсутствующего глифа U+FFFF — у «плашки» ширина одинакова для всех
 * недостающих символов. Результат кэшируем: измерение создаёт канвас.
 */
const glyphCache = new Map<string, boolean>();

function hasGlyph(ch: string): boolean {
  if (!ch) return false;
  const cached = glyphCache.get(ch);
  if (cached !== undefined) return cached;

  let ok = true;
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      ctx.font = getComputedStyle(document.body).font || "16px sans-serif";
      const tofu = ctx.measureText("\uFFFF").width;
      const width = ctx.measureText(ch).width;
      // Если «плашка» имеет нулевую ширину (бывает у некоторых шрифтов),
      // сравнивать не с чем — тогда доверяем факту ненулевой ширины.
      ok = tofu > 0 ? Math.abs(width - tofu) > 0.5 : width > 0;
    }
  } catch {
    // Канвас недоступен (например, в тестовой среде без DOM): не ломаем
    // форматирование, показываем символ как есть.
    ok = true;
  }
  glyphCache.set(ch, ok);
  return ok;
}

/** Чем заменить символ, если его нет в шрифте. Текст рисуется всегда. */
const CURRENCY_TEXT: Record<Currency, string> = {
  RUB: "руб.",
  USD: "USD",
  EUR: "EUR",
  GBP: "GBP",
};

/** Знак валюты, который действительно отобразится. */
export function readSymbol(currency: Currency): string {
  const symbol = CURRENCIES[currency].symbol;
  return hasGlyph(symbol) ? symbol : CURRENCY_TEXT[currency];
}

export function formatNumber(n: number, currency: Currency, compact = false): string {
  const hasFraction = Math.abs(n % 1) > 0.004;
  const symbol = readSymbol(currency);
  // Форматируем число отдельно от валюты: style: "currency" подставляет
  // символ сам, и подставить замену после него не получится.
  const number = new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: hasFraction ? 2 : 0,
    notation: compact ? "compact" : "standard",
  }).format(n);
  return `${number} ${symbol}`;
}

export function formatSigned(n: number, currency: Currency): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${formatNumber(Math.abs(n), currency)}`;
}

export function formatPct(n: number, digits = 1): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(digits).replace(".", ",")}%`;
}

export const percentOf = (part: number, whole: number): number =>
  whole > 0 ? (part / whole) * 100 : 0;

export const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

export function downloadFile(name: string, content: string, mime = "application/json"): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
