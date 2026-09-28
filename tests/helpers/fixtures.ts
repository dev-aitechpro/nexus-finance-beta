// tests/helpers/fixtures.ts
// Генератор тестовых документов данных.
import { emptyData } from "../../src/lib/engine";
import type { AppData, Transaction } from "../../src/lib/types";

export const tx = (over: Partial<Transaction> = {}): Transaction => ({
  id: over.id ?? "t1",
  type: "expense",
  category: "groceries",
  amount: 100,
  description: "Продукты",
  date: "2026-03-01",
  source: "manual",
  status: "confirmed",
  sourceId: null,
  createdAt: "2026-03-01T10:00:00.000Z",
  ...over,
});

export const sampleData = (): AppData => ({
  ...emptyData(),
  transactions: [
    tx({ id: "t1", amount: 100, category: "groceries", date: "2026-03-01" }),
    tx({ id: "t2", amount: 250.5, category: "cafe", date: "2026-03-05", type: "expense" }),
    tx({ id: "t3", amount: 90000, category: "salary", date: "2026-03-10", type: "income" }),
  ],
  subscriptions: [
    { id: "s1", name: "Стриминг", amount: 799, period: "monthly", billingDay: 5, reminderDays: 2, lastConfirmed: null, createdAt: "2026-01-01T00:00:00.000Z" },
  ],
  goals: [
    { id: "g1", name: "Подушка", targetAmount: 300000, savedAmount: 45000, deadline: "2026-12-31", createdAt: "2026-01-01T00:00:00.000Z" },
  ],
  currency: "USD",
  theme: "dark",
  fontScale: 1.15,
});
