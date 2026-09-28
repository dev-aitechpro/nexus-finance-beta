--- src/lib/engine.ts (原始)


+++ src/lib/engine.ts (修改后)
// src/lib/engine.ts
import type {
  AppData, Budget, FixedPayment, Goal, Investment, PendingPayment,
  Subscription, Transaction, TxStatus, SkippedPayment,
} from "./types";
import {
  addDays, addMonths, clampedDate, daysInMonth, daysUntil, monthKey,
  parseISO, percentOf, startOfDay, toISO, uid, formatNumber,
} from "./utils";

/* ────────────────────────── Планировщик платежей ────────────────────────── */

function subDueDate(sub: Subscription, now: Date): Date {
  if (sub.period === "yearly") {
    const m = parseISO(sub.createdAt.slice(0, 10)).getMonth();
    return clampedDate(now.getFullYear(), m, sub.billingDay);
  }
  return clampedDate(now.getFullYear(), now.getMonth(), sub.billingDay);
}

const fixedDueDate = (fp: FixedPayment, now: Date): Date =>
  clampedDate(now.getFullYear(), now.getMonth(), fp.payDay);

function getSourceBaseAmount(
  sourceType: "subscription" | "fixed",
  sourceId: string,
  data: AppData,
  fallback: number,
): number {
  if (sourceType === "subscription") {
    return data.subscriptions.find((s) => s.id === sourceId)?.amount ?? fallback;
  }

  return data.fixedPayments.find((f) => f.id === sourceId)?.amount ?? fallback;
}

function paymentNameWithCarryOver(
  name: string,
  carryOverAmount: number,
): string {
  if (carryOverAmount > 0) {
    return `${name} (включая перенесенные: +${formatNumber(carryOverAmount, "RUB")})`;
  }

  if (carryOverAmount < 0) {
    return `${name} (переплата: ${formatNumber(carryOverAmount, "RUB")})`;
  }

  return name;
}

/**
 * Удаляет предыдущие записи переноса конкретного платежа и, если нужно,
 * добавляет одну актуальную запись.
 */
function replaceCarryOver(
  skippedPayments: SkippedPayment[] | undefined,
  sourceId: string,
  nextCarryOver: SkippedPayment | null,
): SkippedPayment[] {
  const withoutOldCarry = (skippedPayments || []).filter(
    (sp) => !(sp.sourceId === sourceId && sp.carryOver),
  );

  return nextCarryOver
    ? [...withoutOldCarry, nextCarryOver]
    : withoutOldCarry;
}

/** Функция для расчета суммы платежа с учетом переносов и переплат */
export function calculatePaymentWithCarryOver(
  sourceId: string,
  baseAmount: number,
  skippedPayments: SkippedPayment[],
): { totalAmount: number; carryOverAmount: number; hasCarryOver: boolean } {
  const carryOvers = skippedPayments.filter(
    (sp) =>
      sp.sourceId === sourceId &&
      sp.carryOver &&
      sp.carriedAmount !== 0,
  );

  if (carryOvers.length === 0) {
    return {
      totalAmount: baseAmount,
      carryOverAmount: 0,
      hasCarryOver: false,
    };
  }

  const totalCarryOver = carryOvers.reduce(
    (sum, sp) => sum + sp.carriedAmount,
    0,
  );

  return {
    totalAmount: Math.max(0, baseAmount + totalCarryOver),
    carryOverAmount: totalCarryOver,
    hasCarryOver: totalCarryOver !== 0,
  };
}

/**
 * Расчет следующего месяца платежа.
 *
 * baseAmount — обычная стоимость платежа за месяц.
 * paidAmount — фактическая внесенная сумма.
 * carryOverFromPrevious — долг из предыдущего месяца (может быть положительным или отрицательным).
 *
 * Логика:
 * - totalDue = baseAmount + carryOverFromPrevious (сколько всего нужно было внести)
 * - difference = paidAmount - totalDue (разница: положительная = переплата, отрицательная = недоплата)
 * - nextMonthAmount = baseAmount - difference (база следующего месяца корректируется на разницу)
 * - remainingCarryOver = nextMonthAmount - baseAmount (насколько следующий месяц отличается от базы)
 *
 * Примеры при baseAmount = 1000, carryOverFromPrevious = 0:
 * - внесено 0: totalDue = 1000, difference = -1000, nextMonthAmount = 2000, remainingCarryOver = 1000
 * - внесено 400: totalDue = 1000, difference = -600, nextMonthAmount = 1600, remainingCarryOver = 600
 * - внесено 1000: totalDue = 1000, difference = 0, nextMonthAmount = 1000, remainingCarryOver = 0
 * - внесено 1500: totalDue = 1000, difference = 500, nextMonthAmount = 500, remainingCarryOver = -500
 * - внесено 2500: totalDue = 1000, difference = 1500, nextMonthAmount = 0, remainingCarryOver = -1000
 *
 * Примеры при baseAmount = 1000, carryOverFromPrevious = 1000 (пропустили прошлый месяц):
 * - внесено 0: totalDue = 2000, difference = -2000, nextMonthAmount = 3000, remainingCarryOver = 2000
 * - внесено 1000: totalDue = 2000, difference = -1000, nextMonthAmount = 2000, remainingCarryOver = 1000
 * - внесено 2000: totalDue = 2000, difference = 0, nextMonthAmount = 1000, remainingCarryOver = 0
 * - внесено 3000: totalDue = 2000, difference = 1000, nextMonthAmount = 0, remainingCarryOver = -1000
 */
export function calculateNextMonthAmount(
  baseAmount: number,
  paidAmount: number,
  carryOverFromPrevious: number = 0,
): {
  currentMonthAmount: number;
  nextMonthAmount: number;
  remainingCarryOver: number;
} {
  const totalDue = baseAmount + carryOverFromPrevious;
  const difference = paidAmount - totalDue;

  // Следующий месяц: базовая сумма минус переплата (или плюс недоплата)
  const nextMonthAmount = Math.max(0, baseAmount - difference);

  // Остаток переноса — насколько следующий месяц отличается от базовой суммы
  const remainingCarryOver = nextMonthAmount - baseAmount;

  return {
    currentMonthAmount: Math.max(0, totalDue - paidAmount),
    nextMonthAmount,
    remainingCarryOver,
  };
}

/** Генерация pending-платежей с учетом переносов */
export function generatePending(
  subs: Subscription[],
  fixed: FixedPayment[],
  existing: PendingPayment[],
  skippedPayments: SkippedPayment[] = [],
): PendingPayment[] {
  const res = [...existing];
  const today = startOfDay(new Date());
  const stamp = new Date().toISOString();
  const currentMonthKey = monthKey(today);

  for (const s of subs) {
    const due = subDueDate(s, today);
    const dueISO = toISO(due);
    const dueMonthKey = monthKey(parseISO(dueISO));

    if (dueMonthKey !== currentMonthKey) continue;

    const existingIndex = res.findIndex(
      (p) =>
        p.sourceId === s.id &&
        monthKey(parseISO(p.dueDate)) === dueMonthKey,
    );

    if (s.lastConfirmed && monthKey(parseISO(s.lastConfirmed)) === dueMonthKey) {
      continue;
    }

    const skippedInCurrentMonth = skippedPayments.find(
      (sp) =>
        sp.sourceId === s.id &&
        monthKey(parseISO(sp.dueDate)) === dueMonthKey,
    );

    if (skippedInCurrentMonth) continue;

    const carryOverInfo = calculatePaymentWithCarryOver(
      s.id,
      s.amount,
      skippedPayments,
    );

    const name = paymentNameWithCarryOver(
      s.name,
      carryOverInfo.carryOverAmount,
    );

    if (existingIndex >= 0) {
      const current = res[existingIndex];

      res[existingIndex] = {
        ...current,
        name,
        amount: carryOverInfo.totalAmount,
        carryOverAmount: carryOverInfo.carryOverAmount,
      };

      continue;
    }

    res.push({
      id: uid(),
      sourceType: "subscription",
      sourceId: s.id,
      name,
      amount: carryOverInfo.totalAmount,
      category: "subs",
      dueDate: dueISO,
      createdAt: stamp,
      status: "pending",
      skippedCount: 0,
      carryOverAmount: carryOverInfo.carryOverAmount,
    });
  }

  for (const f of fixed) {
    const due = fixedDueDate(f, today);
    const dueISO = toISO(due);
    const dueMonthKey = monthKey(parseISO(dueISO));

    if (dueMonthKey !== currentMonthKey) continue;

    const existingIndex = res.findIndex(
      (p) =>
        p.sourceId === f.id &&
        monthKey(parseISO(p.dueDate)) === dueMonthKey,
    );

    if (f.lastConfirmed && monthKey(parseISO(f.lastConfirmed)) === dueMonthKey) {
      continue;
    }

    const skippedInCurrentMonth = skippedPayments.find(
      (sp) =>
        sp.sourceId === f.id &&
        monthKey(parseISO(sp.dueDate)) === dueMonthKey,
    );

    if (skippedInCurrentMonth) continue;

    const carryOverInfo = calculatePaymentWithCarryOver(
      f.id,
      f.amount,
      skippedPayments,
    );

    const name = paymentNameWithCarryOver(
      f.name,
      carryOverInfo.carryOverAmount,
    );

    if (existingIndex >= 0) {
      const current = res[existingIndex];

      res[existingIndex] = {
        ...current,
        name,
        amount: carryOverInfo.totalAmount,
        carryOverAmount: carryOverInfo.carryOverAmount,
      };

      continue;
    }

    res.push({
      id: uid(),
      sourceType: "fixed",
      sourceId: f.id,
      name,
      amount: carryOverInfo.totalAmount,
      category: f.category,
      dueDate: dueISO,
      createdAt: stamp,
      status: "pending",
      skippedCount: 0,
      carryOverAmount: carryOverInfo.carryOverAmount,
    });
  }

  return res;
}

export interface UpcomingItem {
  key: string;
  name: string;
  amount: number;
  due: string;
  sourceType: "subscription" | "fixed";
  category: string;
  pending: boolean;
}

/** Платежи в ближайшие N дней */
export function upcomingPayments(
  subs: Subscription[],
  fixed: FixedPayment[],
  pendingList: PendingPayment[],
  horizonDays: number,
  skippedPayments: SkippedPayment[] = [],
): UpcomingItem[] {
  const today = startOfDay(new Date());
  const items: UpcomingItem[] = [];

  for (const p of pendingList) {
    items.push({
      key: `p-${p.id}`,
      name: p.name,
      amount: p.amount,
      due: p.dueDate,
      sourceType: p.sourceType,
      category: p.category,
      pending: true,
    });
  }

  const pendingSourceIds = new Set(
    pendingList.map((p) => p.sourceId),
  );

  for (const s of subs) {
    if (pendingSourceIds.has(s.id)) continue;

    let due = subDueDate(s, today);

    if (daysUntil(toISO(due)) < 0) {
      if (s.period === "yearly") {
        due = clampedDate(
          today.getFullYear() + 1,
          parseISO(s.createdAt.slice(0, 10)).getMonth(),
          s.billingDay,
        );
      } else {
        const next = addMonths(today, 1);
        due = clampedDate(
          next.getFullYear(),
          next.getMonth(),
          s.billingDay,
        );
      }
    }

    const carryOverInfo = calculatePaymentWithCarryOver(
      s.id,
      s.amount,
      skippedPayments,
    );

    const days = daysUntil(toISO(due));

    // Перенесенный платеж показываем всегда, даже если его дата дальше horizonDays.
    if (
      !carryOverInfo.hasCarryOver &&
      (days < 0 || days > horizonDays)
    ) {
      continue;
    }

    items.push({
      key: `s-${s.id}`,
      name: paymentNameWithCarryOver(
        s.name,
        carryOverInfo.carryOverAmount,
      ),
      amount: carryOverInfo.totalAmount,
      due: toISO(due),
      sourceType: "subscription",
      category: "subs",
      pending: false,
    });
  }

  for (const f of fixed) {
    if (pendingSourceIds.has(f.id)) continue;

    let due = fixedDueDate(f, today);

    if (daysUntil(toISO(due)) < 0) {
      const next = addMonths(today, 1);
      due = clampedDate(
        next.getFullYear(),
        next.getMonth(),
        f.payDay,
      );
    }

    const carryOverInfo = calculatePaymentWithCarryOver(
      f.id,
      f.amount,
      skippedPayments,
    );

    const days = daysUntil(toISO(due));

    if (
      !carryOverInfo.hasCarryOver &&
      (days < 0 || days > horizonDays)
    ) {
      continue;
    }

    items.push({
      key: `f-${f.id}`,
      name: paymentNameWithCarryOver(
        f.name,
        carryOverInfo.carryOverAmount,
      ),
      amount: carryOverInfo.totalAmount,
      due: toISO(due),
      sourceType: "fixed",
      category: f.category,
      pending: false,
    });
  }

  return items.sort((a, b) => a.due.localeCompare(b.due));
}

/* ────────────────────────────── Бюджетирование ───────────────────────────── */

export type BudgetStatus = "ok" | "warn" | "over";

export interface BudgetStat {
  budget: Budget;
  spent: number;
  prevSpent: number;
  pct: number;
  forecast: number;
  status: BudgetStatus;
}

export function computeBudgetStats(
  budgets: Budget[],
  txs: Transaction[],
  now: Date = new Date(),
): BudgetStat[] {
  const curKey = monthKey(now);
  const prevKey = monthKey(addMonths(now, -1));
  const dim = daysInMonth(now.getFullYear(), now.getMonth());

  return budgets.map((b) => {
    let spent = 0;
    let prevSpent = 0;

    for (const t of txs) {
      if (
        t.type !== "expense" ||
        t.category !== b.category ||
        t.status === "skipped"
      ) {
        continue;
      }

      const k = monthKey(parseISO(t.date));

      if (k === curKey) spent += t.amount;
      else if (k === prevKey) prevSpent += t.amount;
    }

    const pct = percentOf(spent, b.limit);
    const forecast = (spent / Math.max(1, now.getDate())) * dim;
    const status: BudgetStatus =
      pct >= 100 ? "over" : pct >= 70 ? "warn" : "ok";

    return {
      budget: b,
      spent,
      prevSpent,
      pct,
      forecast,
      status,
    };
  });
}

/* ────────────────────────────── Аналитика ───────────────────────────── */

export interface CashflowPoint {
  key: string;
  label: string;
  income: number;
  expense: number;
}

const MONTHS_RU = [
  "янв", "фев", "мар", "апр", "май", "июн",
  "июл", "авг", "сен", "окт", "ноя", "дек",
];

export function cashflowSeries(
  txs: Transaction[],
  months = 6,
): CashflowPoint[] {
  const now = new Date();
  const points: CashflowPoint[] = [];

  for (let i = months - 1; i >= 0; i--) {
    const d = addMonths(now, -i);
    const key = monthKey(d);

    let income = 0;
    let expense = 0;

    for (const t of txs) {
      if (
        t.status === "skipped" ||
        monthKey(parseISO(t.date)) !== key
      ) {
        continue;
      }

      if (t.type === "income") income += t.amount;
      else expense += t.amount;
    }

    points.push({
      key,
      label: MONTHS_RU[d.getMonth()],
      income,
      expense,
    });
  }

  return points;
}

export function monthTotals(
  txs: Transaction[],
  monthOffset = 0,
): { income: number; expense: number } {
  const key = monthKey(addMonths(new Date(), monthOffset));

  let income = 0;
  let expense = 0;

  for (const t of txs) {
    if (
      t.status === "skipped" ||
      monthKey(parseISO(t.date)) !== key
    ) {
      continue;
    }

    if (t.type === "income") income += t.amount;
    else expense += t.amount;
  }

  return { income, expense };
}

export function categoryBreakdown(
  txs: Transaction[],
  monthOffset = 0,
): { id: string; value: number }[] {
  const key = monthKey(addMonths(new Date(), monthOffset));
  const map = new Map<string, number>();

  for (const t of txs) {
    if (
      t.type !== "expense" ||
      t.status === "skipped" ||
      monthKey(parseISO(t.date)) !== key
    ) {
      continue;
    }

    map.set(
      t.category,
      (map.get(t.category) ?? 0) + t.amount,
    );
  }

  return [...map.entries()]
    .map(([id, value]) => ({ id, value }))
    .sort((a, b) => b.value - a.value);
}

export function totals(
  txs: Transaction[],
): { income: number; expense: number; balance: number } {
  let income = 0;
  let expense = 0;

  for (const t of txs) {
    if (t.status === "skipped") continue;

    if (t.type === "income") income += t.amount;
    else expense += t.amount;
  }

  return {
    income,
    expense,
    balance: income - expense,
  };
}

/* ────────────────────────────── Инвестиции ───────────────────────────── */

export function portfolioStats(invs: Investment[]) {
  let invested = 0;
  let value = 0;

  for (const i of invs) {
    invested += i.quantity * i.buyPrice;
    value += i.quantity * i.currentPrice;
  }

  return {
    invested,
    value,
    profit: value - invested,
    pct: percentOf(value - invested, invested),
  };
}

/* ──────────────────────────── Сложный процент ──────────────────────────── */

export function compoundFV(
  p0: number,
  monthly: number,
  annualPct: number,
  months: number,
): number {
  const i = annualPct / 100 / 12;

  if (i <= 0) return p0 + monthly * months;

  const g = Math.pow(1 + i, months);

  return p0 * g + monthly * ((g - 1) / i);
}

export interface CompoundPoint {
  year: number;
  value: number;
  invested: number;
}

export function compoundSeries(
  p0: number,
  monthly: number,
  annualPct: number,
  years: number,
): CompoundPoint[] {
  const pts: CompoundPoint[] = [];

  for (let y = 0; y <= years; y++) {
    const m = y * 12;

    pts.push({
      year: y,
      value: compoundFV(p0, monthly, annualPct, m),
      invested: p0 + monthly * m,
    });
  }

  return pts;
}

export function monthsToTarget(
  p0: number,
  monthly: number,
  annualPct: number,
  target: number,
): number | null {
  if (target <= p0) return 0;

  for (let m = 1; m <= 1200; m++) {
    if (compoundFV(p0, monthly, annualPct, m) >= target) {
      return m;
    }
  }

  return null;
}

/* ────────────────────────────── Работа с платежами ───────────────────────────── */

/** Подтверждение платежа с реальной суммой и расчетом переноса */
export function confirmPaymentWithAmount(
  pendingId: string,
  actualAmount: number,
  data: AppData,
): { updatedData: AppData; transaction: Transaction } {
  const p = data.pendingPayments.find((x) => x.id === pendingId);

  if (!p || actualAmount <= 0) {
    throw new Error("Платеж не найден или сумма некорректна");
  }

  const baseAmount = getSourceBaseAmount(
    p.sourceType,
    p.sourceId,
    data,
    Math.max(0, p.amount - (p.carryOverAmount || 0)),
  );

  const carryOverFromPrevious = p.carryOverAmount || 0;

  const calculation = calculateNextMonthAmount(
    baseAmount,
    actualAmount,
    carryOverFromPrevious,
  );

  const tx: Transaction = {
    id: uid(),
    type: "expense",
    category: p.category,
    amount: actualAmount,
    description: p.name,
    date: new Date().toISOString().slice(0, 10),
    source: p.sourceType === "subscription"
      ? "subscription"
      : "payment",
    status: "confirmed",
    sourceId: p.sourceId,
    createdAt: new Date().toISOString(),
  };

  const carryRecord: SkippedPayment | null =
    calculation.remainingCarryOver !== 0
      ? {
          id: uid(),
          sourceId: p.sourceId,
          sourceType: p.sourceType,
          originalAmount: baseAmount,
          skippedDate: new Date().toISOString().slice(0, 10),
          dueDate: p.dueDate,
          carryOver: true,
          carriedAmount: calculation.remainingCarryOver,
        }
      : null;

  const updatedData: AppData = {
    ...data,
    transactions: [...data.transactions, tx],
    pendingPayments: data.pendingPayments.filter(
      (x) => x.id !== pendingId,
    ),
    skippedPayments: replaceCarryOver(
      data.skippedPayments,
      p.sourceId,
      carryRecord,
    ),
  };

  if (p.sourceType === "subscription") {
    updatedData.subscriptions = data.subscriptions.map((s) =>
      s.id === p.sourceId
        ? { ...s, lastConfirmed: p.dueDate }
        : s,
    );
  } else {
    updatedData.fixedPayments = data.fixedPayments.map((f) =>
      f.id === p.sourceId
        ? { ...f, lastConfirmed: p.dueDate }
        : f,
    );
  }

  return { updatedData, transaction: tx };
}

/**
 * Подтверждение платежа досрочно.
 *
 * Подходит для ситуаций, когда пользователь хочет оплатить регулярный
 * платеж раньше дня оплаты и ввести фактическую сумму.
 */
export function confirmSourcePaymentWithAmount(
  sourceType: "subscription" | "fixed",
  sourceId: string,
  actualAmount: number,
  data: AppData,
): { updatedData: AppData; transaction: Transaction } {
  const pendingList = generatePending(
    data.subscriptions,
    data.fixedPayments,
    data.pendingPayments,
    data.skippedPayments || [],
  );

  const currentMonth = monthKey(startOfDay(new Date()));

  const pending = pendingList.find(
    (p) =>
      p.sourceType === sourceType &&
      p.sourceId === sourceId &&
      monthKey(parseISO(p.dueDate)) === currentMonth,
  );

  if (!pending) {
    throw new Error("Платеж для подтверждения в текущем месяце не найден");
  }

  const dataWithPending: AppData = {
    ...data,
    pendingPayments: data.pendingPayments.some((p) => p.id === pending.id)
      ? data.pendingPayments
      : pendingList,
  };

  return confirmPaymentWithAmount(
    pending.id,
    actualAmount,
    dataWithPending,
  );
}

/** Пропуск платежа с выбором переноса */
export function skipPaymentWithCarry(
  pendingId: string,
  carryOver: boolean,
  data: AppData,
): AppData {
  const p = data.pendingPayments.find((x) => x.id === pendingId);

  if (!p) return data;

  const tx: Transaction = {
    id: uid(),
    type: "expense",
    category: p.category,
    amount: 0,
    description: `${p.name} (пропущен${carryOver ? " с переносом" : ""})`,
    date: p.dueDate,
    source: p.sourceType === "subscription"
      ? "subscription"
      : "payment",
    status: "skipped",
    sourceId: p.sourceId,
    createdAt: new Date().toISOString(),
  };

  const skippedPayment: SkippedPayment = {
    id: uid(),
    sourceId: p.sourceId,
    sourceType: p.sourceType,
    originalAmount: p.amount,
    skippedDate: new Date().toISOString().slice(0, 10),
    dueDate: p.dueDate,
    carryOver,
    /*
      p.amount уже содержит предыдущий долг, если он был.
      Поэтому сумма не складывается повторно — иначе долг удваивается.
    */
    carriedAmount: carryOver ? p.amount : 0,
  };

  const updatedData: AppData = {
    ...data,
    transactions: [...data.transactions, tx],
    pendingPayments: data.pendingPayments.filter(
      (x) => x.id !== pendingId,
    ),
    skippedPayments: replaceCarryOver(
      data.skippedPayments,
      p.sourceId,
      skippedPayment,
    ),
  };

  /*
    ВАЖНО:
    Pending на следующий месяц здесь намеренно НЕ создается.

    Благодаря этому платеж исчезает из вкладки подтверждений сейчас.
    Сумма хранится в skippedPayments и отображается в upcomingPayments.
    В следующем месяце generatePending автоматически создаст новый pending.
  */

  if (p.sourceType === "subscription") {
    updatedData.subscriptions = data.subscriptions.map((s) =>
      s.id === p.sourceId
        ? { ...s, lastConfirmed: p.dueDate }
        : s,
    );
  } else {
    updatedData.fixedPayments = data.fixedPayments.map((f) =>
      f.id === p.sourceId
        ? { ...f, lastConfirmed: p.dueDate }
        : f,
    );
  }

  return updatedData;
}

/** Полное удаление транзакции */
export function deleteTransactionCompletely(
  transactionId: string,
  data: AppData,
): AppData {
  const tx = data.transactions.find((t) => t.id === transactionId);

  const newTransactions = data.transactions.filter(
    (t) => t.id !== transactionId,
  );

  let newSkippedPayments = data.skippedPayments || [];

  if (tx && tx.status === "skipped" && tx.amount === 0) {
    const relatedSkipped = newSkippedPayments.find(
      (sp) =>
        sp.sourceId === tx.sourceId &&
        sp.dueDate === tx.date,
    );

    if (relatedSkipped) {
      newSkippedPayments = newSkippedPayments.filter(
        (sp) => sp.id !== relatedSkipped.id,
      );
    }
  }

  let newSubscriptions = data.subscriptions;
  let newFixedPayments = data.fixedPayments;
  let newPendingPayments = data.pendingPayments;

  if (
    tx &&
    (tx.source === "subscription" || tx.source === "payment") &&
    tx.sourceId
  ) {
    const monthKeyNow = new Date().toISOString().slice(0, 7);

    const hasOtherConfirmation = data.transactions.some(
      (t) =>
        t.id !== transactionId &&
        t.sourceId === tx.sourceId &&
        t.status === "confirmed" &&
        t.date.slice(0, 7) === monthKeyNow,
    );

    if (!hasOtherConfirmation) {
      if (tx.source === "subscription") {
        newSubscriptions = data.subscriptions.map((s) =>
          s.id === tx.sourceId
            ? { ...s, lastConfirmed: null }
            : s,
        );
      } else {
        newFixedPayments = data.fixedPayments.map((f) =>
          f.id === tx.sourceId
            ? { ...f, lastConfirmed: null }
            : f,
        );
      }
    }

    const txMonthKey = tx.date.slice(0, 7);

    newPendingPayments = data.pendingPayments.filter(
      (p) =>
        !(
          p.sourceId === tx.sourceId &&
          p.dueDate.slice(0, 7) === txMonthKey
        ),
    );
  }

  return {
    ...data,
    transactions: newTransactions,
    skippedPayments: newSkippedPayments,
    subscriptions: newSubscriptions,
    fixedPayments: newFixedPayments,
    pendingPayments: newPendingPayments,
  };
}

/** Восстановление удаленной транзакции регулярного платежа */
export function restoreDeletedPayment(
  transactionId: string,
  data: AppData,
): AppData | null {
  const tx = data.transactions.find((t) => t.id === transactionId);

  if (
    !tx ||
    (tx.source !== "subscription" && tx.source !== "payment")
  ) {
    return null;
  }

  if (!tx.sourceId) return null;

  const pendingPayment: PendingPayment = {
    id: uid(),
    sourceType: tx.source === "subscription"
      ? "subscription"
      : "fixed",
    sourceId: tx.sourceId,
    name: tx.description || tx.category || "Восстановленный платеж",
    amount: tx.amount,
    category: tx.category,
    dueDate: tx.date,
    createdAt: new Date().toISOString(),
    status: "pending",
    skippedCount: 0,
    carryOverAmount: 0,
  };

  const updatedData = { ...data };

  updatedData.transactions = data.transactions.filter(
    (t) => t.id !== transactionId,
  );

  updatedData.pendingPayments = [
    ...data.pendingPayments,
    pendingPayment,
  ];

  if (tx.source === "subscription") {
    updatedData.subscriptions = data.subscriptions.map((s) =>
      s.id === tx.sourceId
        ? { ...s, lastConfirmed: null }
        : s,
    );
  } else {
    updatedData.fixedPayments = data.fixedPayments.map((f) =>
      f.id === tx.sourceId
        ? { ...f, lastConfirmed: null }
        : f,
    );
  }

  return updatedData;
}

/**
 * Полное удаление обязательного платежа (подписки или фиксированного платежа).
 *
 * Эта функция полностью удаляет:
 * - Сам источник платежа (subscription или fixedPayment)
 * - Все связанные транзакции (confirmed и skipped)
 * - Все pending платежи
 * - Все записи о переносах (skippedPayments с carryOver)
 *
 * Используйте эту функцию, когда хотите полностью избавиться от платежа.
 */
export function deletePaymentSourceCompletely(
  sourceType: "subscription" | "fixed",
  sourceId: string,
  data: AppData,
): AppData {
  let updatedData: AppData = { ...data };

  // Удаляем сам источник платежа
  if (sourceType === "subscription") {
    updatedData.subscriptions = data.subscriptions.filter(
      (s) => s.id !== sourceId,
    );
  } else {
    updatedData.fixedPayments = data.fixedPayments.filter(
      (f) => f.id !== sourceId,
    );
  }

  // Удаляем все связанные транзакции
  updatedData.transactions = data.transactions.filter(
    (t) => t.sourceId !== sourceId,
  );

  // Удаляем все pending платежи этого источника
  updatedData.pendingPayments = data.pendingPayments.filter(
    (p) => p.sourceId !== sourceId,
  );

  // Удаляем все записи о переносах этого источника
  updatedData.skippedPayments = (data.skippedPayments || []).filter(
    (sp) => sp.sourceId !== sourceId,
  );

  return updatedData;
}

/**
 * Удаление обязательного платежа из вкладки транзакций.
 *
 * Если транзакция имеет sourceId (связана с подпиской или фиксированным платежом),
 * эта функция позволяет полностью удалить её вместе со всеми связанными данными.
 *
 * @param transactionId - ID транзакции для удаления
 * @param data - текущие данные приложения
 * @returns обновленные данные приложения
 */
export function deletePaymentTransactionCompletely(
  transactionId: string,
  data: AppData,
): AppData {
  const tx = data.transactions.find((t) => t.id === transactionId);

  if (!tx) {
    return data;
  }

  // Если это транзакция обязательного платежа (имеет sourceId)
  if (tx.sourceId && (tx.source === "subscription" || tx.source === "payment")) {
    // Удаляем саму транзакцию
    const newTransactions = data.transactions.filter(
      (t) => t.id !== transactionId,
    );

    // Если это skipped транзакция, удаляем связанную запись переноса
    let newSkippedPayments = data.skippedPayments || [];
    if (tx.status === "skipped") {
      newSkippedPayments = newSkippedPayments.filter(
        (sp) => !(sp.sourceId === tx.sourceId && sp.dueDate === tx.date),
      );
    }

    // Удаляем связанные pending платежи
    const newPendingPayments = data.pendingPayments.filter(
      (p) => p.sourceId !== tx.sourceId,
    );

    // Если это была единственная транзакция за месяц, сбрасываем lastConfirmed
    const monthKeyTx = tx.date.slice(0, 7);
    const hasOtherInSameMonth = data.transactions.some(
      (t) =>
        t.id !== transactionId &&
        t.sourceId === tx.sourceId &&
        t.date.slice(0, 7) === monthKeyTx,
    );

    let newSubscriptions = data.subscriptions;
    let newFixedPayments = data.fixedPayments;

    if (!hasOtherInSameMonth) {
      if (tx.source === "subscription") {
        newSubscriptions = data.subscriptions.map((s) =>
          s.id === tx.sourceId
            ? { ...s, lastConfirmed: null }
            : s,
        );
      } else {
        newFixedPayments = data.fixedPayments.map((f) =>
          f.id === tx.sourceId
            ? { ...f, lastConfirmed: null }
            : f,
        );
      }
    }

    return {
      ...data,
      transactions: newTransactions,
      skippedPayments: newSkippedPayments,
      pendingPayments: newPendingPayments,
      subscriptions: newSubscriptions,
      fixedPayments: newFixedPayments,
    };
  }

  // Если это обычная транзакция без sourceId, используем стандартное удаление
  return deleteTransactionCompletely(transactionId, data);
}

/* ────────────────────────────── Демо-данные ───────────────────────────── */

export function buildSeed(): AppData {
  let seed = 20260214;

  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const ri = (min: number, max: number) =>
    Math.floor(rnd() * (max - min + 1)) + min;

  const pick = <T,>(arr: T[]): T =>
    arr[Math.floor(rnd() * arr.length)];

  const now = new Date();
  const txs: Transaction[] = [];

  const stamp = (d: Date) => `${toISO(d)}T12:00:00.000Z`;

  const push = (
    type: "income" | "expense",
    category: string,
    amount: number,
    description: string,
    date: Date,
    source: Transaction["source"] = "manual",
    status: TxStatus = "confirmed",
    sourceId: string | null = null,
  ) => {
    txs.push({
      id: uid(),
      type,
      category,
      amount: Math.round(amount),
      description,
      date: toISO(date),
      source,
      status,
      sourceId,
      createdAt: stamp(date),
    });
  };

  const prevDue = (day: number) => {
    const d = addMonths(now, -1);
    return toISO(clampedDate(
      d.getFullYear(),
      d.getMonth(),
      day,
    ));
  };

  const subscriptions: Subscription[] = [
    {
      id: "sub-yandex",
      name: "Яндекс Плюс",
      amount: 399,
      period: "monthly",
      billingDay: 3,
      reminderDays: 2,
      lastConfirmed: prevDue(3),
      createdAt: stamp(addMonths(now, -7)),
    },
    {
      id: "sub-spotify",
      name: "Spotify Premium",
      amount: 599,
      period: "monthly",
      billingDay: 12,
      reminderDays: 3,
      lastConfirmed: prevDue(12),
      createdAt: stamp(addMonths(now, -9)),
    },
    {
      id: "sub-icloud",
      name: "iCloud+ 200 ГБ",
      amount: 149,
      period: "monthly",
      billingDay: 17,
      reminderDays: 1,
      lastConfirmed: prevDue(17),
      createdAt: stamp(addMonths(now, -11)),
    },
    {
      id: "sub-adobe",
      name: "Adobe Creative Cloud",
      amount: 1890,
      period: "yearly",
      billingDay: 24,
      reminderDays: 5,
      lastConfirmed: toISO(clampedDate(
        now.getFullYear() - 1,
        addMonths(now, -14).getMonth(),
        24,
      )),
      createdAt: stamp(addMonths(now, -14)),
    },
  ];

  const fixedPayments: FixedPayment[] = [
    {
      id: "fp-rent",
      name: "Аренда квартиры",
      amount: 35000,
      category: "housing",
      payDay: 5,
      autoPay: true,
      lastConfirmed: prevDue(5),
      createdAt: stamp(addMonths(now, -8)),
    },
    {
      id: "fp-net",
      name: "Домашний интернет",
      amount: 650,
      category: "housing",
      payDay: 15,
      autoPay: true,
      lastConfirmed: prevDue(15),
      createdAt: stamp(addMonths(now, -8)),
    },
    {
      id: "fp-elec",
      name: "Электричество и вода",
      amount: 1450,
      category: "housing",
      payDay: 20,
      autoPay: false,
      lastConfirmed: prevDue(20),
      createdAt: stamp(addMonths(now, -8)),
    },
  ];

  const budgets: Budget[] = [
    { id: uid(), category: "groceries", limit: 24000, createdAt: stamp(addMonths(now, -3)) },
    { id: uid(), category: "cafe", limit: 9000, createdAt: stamp(addMonths(now, -3)) },
    { id: uid(), category: "transport", limit: 5000, createdAt: stamp(addMonths(now, -2)) },
    { id: uid(), category: "fun", limit: 7000, createdAt: stamp(addMonths(now, -2)) },
    { id: uid(), category: "shopping", limit: 15000, createdAt: stamp(addMonths(now, -1)) },
  ];

  const goals: Goal[] = [
    {
      id: "g-cushion",
      name: "Финансовая подушка",
      targetAmount: 300000,
      savedAmount: 120000,
      deadline: toISO(addMonths(now, 9)),
      createdAt: stamp(addMonths(now, -6)),
    },
    {
      id: "g-mac",
      name: "MacBook Pro",
      targetAmount: 250000,
      savedAmount: 42500,
      deadline: toISO(addMonths(now, 7)),
      createdAt: stamp(addMonths(now, -5)),
    },
    {
      id: "g-japan",
      name: "Отпуск в Японии",
      targetAmount: 180000,
      savedAmount: 32000,
      deadline: toISO(addMonths(now, 12)),
      createdAt: stamp(addMonths(now, -4)),
    },
  ];

  const investments: Investment[] = [
    { id: uid(), ticker: "SBER", quantity: 40, buyPrice: 245, currentPrice: 287.4, createdAt: stamp(addMonths(now, -5)) },
    { id: uid(), ticker: "YDEX", quantity: 25, buyPrice: 3100, currentPrice: 3958, createdAt: stamp(addMonths(now, -4)) },
    { id: uid(), ticker: "LKOH", quantity: 2, buyPrice: 6800, currentPrice: 7245, createdAt: stamp(addMonths(now, -3)) },
    { id: uid(), ticker: "TATL", quantity: 30, buyPrice: 720, currentPrice: 812, createdAt: stamp(addMonths(now, -2)) },
    { id: uid(), ticker: "MOEX", quantity: 20, buyPrice: 185, currentPrice: 201.6, createdAt: stamp(addMonths(now, -1)) },
  ];

  for (let m = 5; m >= 0; m--) {
    const base = addMonths(now, -m);
    const y = base.getFullYear();
    const mo = base.getMonth();
    const isCurrent = m === 0;

    const d = (day: number) => clampedDate(y, mo, day);
    const ok = (day: number) =>
      !isCurrent || d(day) <= startOfDay(now);

    if (ok(7)) {
      push("income", "salary", 185000, "Зарплата", d(7));
    }

    if (rnd() > 0.35) {
      const fd = ri(10, 26);
      if (ok(fd)) {
        push(
          "income",
          "freelance",
          ri(12, 42) * 1000,
          "Фриланс-проект",
          d(fd),
        );
      }
    }

    if (ok(9)) {
      push(
        "expense",
        "savings",
        20000,
        "Пополнение: Финансовая подушка",
        d(9),
        "goal",
        "confirmed",
        "g-cushion",
      );
    }

    if (m >= 1 && ok(14)) {
      push(
        "expense",
        "savings",
        8500,
        "Пополнение: MacBook Pro",
        d(14),
        "goal",
        "confirmed",
        "g-mac",
      );
    }

    if (m <= 3 && ok(21)) {
      push(
        "expense",
        "savings",
        8000,
        "Пополнение: Отпуск в Японии",
        d(21),
        "goal",
        "confirmed",
        "g-japan",
      );
    }

    if (ok(5)) {
      push(
        "expense",
        "housing",
        35000,
        "Аренда квартиры",
        d(5),
        "payment",
        "confirmed",
        "fp-rent",
      );
    }

    if (ok(15)) {
      push(
        "expense",
        "housing",
        650,
        "Домашний интернет",
        d(15),
        "payment",
        "confirmed",
        "fp-net",
      );
    }

    if (ok(20)) {
      push(
        "expense",
        "housing",
        ri(1100, 1800),
        "Электричество и вода",
        d(20),
        "payment",
        "confirmed",
        "fp-elec",
      );
    }

    if (m > 0) {
      push(
        "expense",
        "subs",
        399,
        "Яндекс Плюс",
        d(3),
        "subscription",
        "confirmed",
        "sub-yandex",
      );

      push(
        "expense",
        "subs",
        599,
        "Spotify Premium",
        d(12),
        "subscription",
        "confirmed",
        "sub-spotify",
      );

      push(
        "expense",
        "subs",
        149,
        "iCloud+ 200 ГБ",
        d(17),
        "subscription",
        "confirmed",
        "sub-icloud",
      );
    }

    if (m === 2) {
      push(
        "expense",
        "subs",
        799,
        "Netflix — платёж пропущен",
        d(13),
        "subscription",
        "skipped",
      );
    }

    for (const gd of [2, 6, 11, 16, 22, 27]) {
      if (rnd() > 0.22 && ok(gd)) {
        push(
          "expense",
          "groceries",
          ri(900, 4200),
          pick([
            "Пятёрочка",
            "ВкусВилл",
            "Лента",
            "Рынок",
            "Перекрёсток",
          ]),
          d(gd),
        );
      }
    }

    for (let i = 0; i < 4; i++) {
      const cd = ri(1, 28);

      if (rnd() > 0.3 && ok(cd)) {
        push(
          "expense",
          "cafe",
          ri(450, 2600),
          pick([
            "Кофейня",
            "Обед с коллегами",
            "Ужин",
            "Доставка еды",
          ]),
          d(cd),
        );
      }
    }

    for (const td of [4, 10, 17, 24]) {
      if (rnd() > 0.35 && ok(td)) {
        push(
          "expense",
          "transport",
          ri(280, 720),
          pick([
            "Метро и автобус",
            "Такси",
            "Каршеринг",
            "Топливо",
          ]),
          d(td),
        );
      }
    }

    for (let i = 0; i < 2; i++) {
      const fd2 = ri(1, 28);

      if (rnd() > 0.32 && ok(fd2)) {
        push(
          "expense",
          "fun",
          ri(700, 3800),
          pick([
            "Кино",
            "Концерт",
            "Игры",
            "Боулинг",
          ]),
          d(fd2),
        );
      }
    }

    for (let i = 0, n = ri(1, 2); i < n; i++) {
      const sd = ri(1, 28);

      if (ok(sd)) {
        push(
          "expense",
          "shopping",
          ri(1500, 9500),
          pick([
            "Одежда",
            "Электроника",
            "Товары для дома",
            "Подарок",
          ]),
          d(sd),
        );
      }
    }

    if (rnd() > 0.6) {
      const hd = ri(1, 28);

      if (ok(hd)) {
        push(
          "expense",
          "health",
          ri(900, 4200),
          pick([
            "Аптека",
            "Стоматолог",
            "Анализы",
          ]),
          d(hd),
        );
      }
    }
  }

  return {
    transactions: txs,
    subscriptions,
    fixedPayments,
    budgets,
    goals,
    investments,
    pendingPayments: [],
    skippedPayments: [],
    currency: "RUB",
    theme: "cyberpunk",
    fontScale: 1,
  };
}

export const emptyData = (): AppData => ({
  transactions: [],
  subscriptions: [],
  fixedPayments: [],
  budgets: [],
  goals: [],
  investments: [],
  pendingPayments: [],
  skippedPayments: [],
  currency: "RUB",
  theme: "cyberpunk",
  fontScale: 1,
});

export const txStatusFromPending = (
  p: PendingPayment,
): Transaction => ({
  id: p.id,
  type: "expense",
  category: p.category,
  amount: p.amount,
  description: p.name,
  date: p.dueDate,
  source: p.sourceType === "subscription"
    ? "subscription"
    : "payment",
  status: "pending",
  sourceId: p.sourceId,
  createdAt: p.createdAt,
});

export const isReached = (g: Goal): boolean =>
  g.savedAmount >= g.targetAmount;

export const goalMonthlyNeed = (g: Goal): number => {
  const monthsLeft = Math.max(
    1,
    Math.ceil(daysUntil(g.deadline) / 30),
  );

  return Math.max(
    0,
    (g.targetAmount - g.savedAmount) / monthsLeft,
  );
};
