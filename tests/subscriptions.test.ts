// tests/subscriptions.test.ts
// Регулярные платежи: удаление не должно «воскресать», а платежи будущего
// месяца не должны требовать подтверждения (жалобы пользователя).
import { describe, expect, it } from "vitest";
import { emptyData } from "../src/lib/engine";
import {
  confirmPaymentWithAmount,
  deletePaymentSourceCompletely,
  deleteTransactionCompletely,
  generatePending,
  isActionablePending,
  pendingKind,
  skipPaymentWithCarry,
  txStatusFromPending,
} from "../src/lib/engine";
import type { AppData, PendingPayment, Subscription } from "../src/lib/types";
import { tx } from "./helpers/fixtures";

const month = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

const addMonths = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth() + n, 1);

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  id: "s1",
  name: "Стриминг",
  amount: 799,
  period: "monthly",
  billingDay: 1,
  reminderDays: 2,
  lastConfirmed: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const pending = (over: Partial<PendingPayment> = {}): PendingPayment => ({
  id: "p1",
  sourceType: "subscription",
  sourceId: "s1",
  name: "Стриминг",
  amount: 799,
  category: "subs",
  dueDate: "2026-09-01",
  createdAt: "2026-09-01T00:00:00.000Z",
  status: "pending",
  skippedCount: 0,
  carryOverAmount: 0,
  ...over,
});

const base = (over: Partial<AppData> = {}): AppData => ({ ...emptyData(), ...over });

describe("Вид платежа по месяцу", () => {
  const now = new Date(2026, 8, 15); // сентябрь 2026

  it("различает просроченный, текущий и запланированный", () => {
    expect(pendingKind(pending({ dueDate: "2026-08-01" }), now)).toBe("overdue");
    expect(pendingKind(pending({ dueDate: "2026-09-20" }), now)).toBe("current");
    expect(pendingKind(pending({ dueDate: "2026-10-05" }), now)).toBe("planned");
  });

  it("запланированный платёж не требует подтверждения", () => {
    expect(isActionablePending(pending({ dueDate: "2026-10-05" }), now)).toBe(false);
    expect(isActionablePending(pending({ dueDate: "2026-09-20" }), now)).toBe(true);
    expect(isActionablePending(pending({ dueDate: "2026-08-01" }), now)).toBe(true);
  });

  it("пропущенный месяц тоже не спрашивается заново", () => {
    // После пропуска в журнале остаётся нулевая запись — её тоже не должно
    // быть видно как «ожидающий подтверждения» платёж.
    const nowSep = new Date(2026, 8, 15);
    expect(pendingKind(pending({ dueDate: "2026-09-05", status: "skipped" }), nowSep)).toBe("current");
  });
});

describe("Подтверждение: следующий месяц не требует подтверждения сразу", () => {
  it("после подтверждения появляется платёж следующего месяца со статусом «запланирован»", () => {
    const now = new Date(2026, 8, 15);
    const dueThisMonth = "2026-09-20";
    const data = base({
      subscriptions: [sub({ lastConfirmed: null })],
      pendingPayments: [pending({ dueDate: dueThisMonth })],
    });

    const { updatedData: next } = confirmPaymentWithAmount("p1", 799, data);
    // Запись-платёж создана в журнале
    expect(next.transactions.some((t) => t.sourceId === "s1" && t.status === "confirmed")).toBe(true);
    // Платёж следующего месяца создан заранее (чтобы пропуск месяца не потерялся)
    const future = next.pendingPayments.find((p) => month(parseDate(p.dueDate)) === month(addMonths(now, 1)));
    expect(future).toBeDefined();
    // Но подтверждать его сейчас не нужно
    expect(isActionablePending(future!, now)).toBe(false);
    // Текущий месяц закрыт
    expect(next.subscriptions[0].lastConfirmed).toBe(dueThisMonth);
  });
});

const parseDate = (iso: string): Date => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};

describe("Удаление операции из подписки", () => {
  const now = new Date(2026, 8, 15);

  it("удаляет запись и НЕ возвращает её к подтверждению", () => {
    const dueThisMonth = "2026-09-20";
    const data = base({
      subscriptions: [sub({ lastConfirmed: dueThisMonth })],
      transactions: [
        tx({ id: "sub-tx-1", source: "subscription", sourceId: "s1", category: "subs", amount: 799, date: dueThisMonth, description: "Стриминг" }),
      ],
      pendingPayments: [pending({ id: "p-current", dueDate: dueThisMonth })],
    });

    const after = deleteTransactionCompletely("sub-tx-1", data);
    expect(after.transactions.find((t) => t.id === "sub-tx-1")).toBeUndefined();
    // Платёй этого месяца тоже убран — он больше не просит подтверждения
    expect(after.pendingPayments.find((p) => p.id === "p-current")).toBeUndefined();

    // Генератор не создаёт его заново: месяц закрыт датой операции
    const regenerated = generatePending(after.subscriptions, after.fixedPayments, after.pendingPayments, after.skippedPayments);
    expect(regenerated.filter((p) => p.sourceId === "s1" && pendingKind(p, now) === "current")).toHaveLength(0);
  });

  it("удаление записи прошлого месяца не закрывает текущий", () => {
    const data = base({
      subscriptions: [sub({ lastConfirmed: null })],
      transactions: [
        tx({ id: "sub-tx-old", source: "subscription", sourceId: "s1", category: "subs", amount: 799, date: "2026-05-10" }),
      ],
    });
    const after = deleteTransactionCompletely("sub-tx-old", data);
    expect(after.transactions).toHaveLength(0);
    // За прошлый месят удалили — текущий месяц по-прежнему ждёт подтверждения
    const regenerated = generatePending(after.subscriptions, after.fixedPayments, after.pendingPayments, after.skippedPayments);
    expect(regenerated.filter((p) => pendingKind(p, now) === "current")).toHaveLength(1);
  });

  it("удаление самой подписки убирает её операции, платежи и переносы", () => {
    const data = base({
      subscriptions: [sub()],
      fixedPayments: [],
      transactions: [
        tx({ id: "a", source: "subscription", sourceId: "s1", category: "subs", date: "2026-08-10" }),
        tx({ id: "b", source: "subscription", sourceId: "s1", category: "subs", date: "2026-09-10" }),
        tx({ id: "manual-keep", source: "manual", category: "cafe", date: "2026-09-11" }),
      ],
      pendingPayments: [pending({ id: "p1", dueDate: "2026-10-01" })],
      skippedPayments: [
        { id: "sp1", sourceId: "s1", sourceType: "subscription", originalAmount: 799, skippedDate: "2026-08-05", dueDate: "2026-08-05", carryOver: false, carriedAmount: 0 },
      ],
    });

    const after = deletePaymentSourceCompletely("subscription", "s1", data);
    expect(after.subscriptions).toHaveLength(0);
    expect(after.transactions.map((t) => t.id)).toEqual(["manual-keep"]);
    expect(after.pendingPayments).toHaveLength(0);
    expect(after.skippedPayments).toHaveLength(0);
  });
});

describe("Пропуск платежа", () => {
  const now = new Date(2026, 8, 15);

  it("закрывает месяц: платёж не генерируется заново", () => {
    const due = "2026-09-20";
    const data = base({
      subscriptions: [sub({ lastConfirmed: null })],
      pendingPayments: [pending({ id: "p1", dueDate: due })],
    });

    const after = skipPaymentWithCarry("p1", false, data);
    // В журнале остаётся нулевая запись «пропущено» — как след
    expect(after.transactions.some((t) => t.status === "skipped" && t.amount === 0)).toBe(true);
    // Платёж удалён из очереди, месяц закрыт
    expect(after.pendingPayments.find((p) => p.id === "p1")).toBeUndefined();

    const regenerated = generatePending(after.subscriptions, after.fixedPayments, after.pendingPayments, after.skippedPayments);
    expect(regenerated.filter((p) => pendingKind(p, now) === "current")).toHaveLength(0);
  });

  it("нулевая запись «пропущено» удаляется без воскрешения", () => {
    const due = "2026-09-20";
    const data = base({
      subscriptions: [sub({ lastConfirmed: null })],
      pendingPayments: [pending({ id: "p1", dueDate: due })],
    });
    const skipped = skipPaymentWithCarry("p1", false, data);
    const skippedTx = skipped.transactions.find((t) => t.status === "skipped");
    expect(skippedTx).toBeDefined();

    const after = deleteTransactionCompletely(skippedTx!.id, skipped);
    expect(after.transactions.find((t) => t.id === skippedTx!.id)).toBeUndefined();
    expect(after.skippedPayments).toHaveLength(0);
  });
});

describe("Планированные платежи не попадают в журнал как требующие действия", () => {
  it("txStatusFromPending помечает источник и месяц", () => {
    const t = txStatusFromPending(pending({ id: "p1", dueDate: "2026-10-05" }));
    expect(t.source).toBe("subscription");
    expect(t.status).toBe("pending");
    expect(t.date).toBe("2026-10-05");
  });
});
