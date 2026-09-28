// src/lib/types.ts
export type TxType = "income" | "expense";
export type TxSource = "manual" | "subscription" | "payment" | "goal";
export type TxStatus = "confirmed" | "pending" | "skipped";
export type Period = "monthly" | "yearly";
export type Theme = "cyberpunk" | "dark" | "light";
export type Currency = "RUB" | "USD" | "EUR" | "GBP";
export type Tab =
  | "dashboard"
  | "transactions"
  | "payments"
  | "confirm"
  | "budget"
  | "goals"
  | "investments"
  | "scanner"
  | "settings";

export interface Transaction {
  id: string;
  type: TxType;
  category: string;
  amount: number;
  description: string | null;
  date: string; // ISO yyyy-mm-dd
  source: TxSource;
  status: TxStatus;
  sourceId: string | null;
  createdAt: string;
}

export interface TransactionInput {
  type: TxType;
  category: string;
  amount: number;
  description: string | null;
  date: string;
  source: TxSource;
}

export interface Subscription {
  id: string;
  name: string;
  amount: number;
  period: Period;
  billingDay: number;
  reminderDays: number;
  lastConfirmed: string | null;
  createdAt: string;
}

export interface FixedPayment {
  id: string;
  name: string;
  amount: number;
  category: string;
  payDay: number;
  autoPay: boolean;
  lastConfirmed: string | null;
  createdAt: string;
}

export interface Budget {
  id: string;
  category: string;
  limit: number;
  createdAt: string;
}

export interface Goal {
  id: string;
  name: string;
  targetAmount: number;
  savedAmount: number;
  deadline: string;
  createdAt: string;
}

export interface Investment {
  id: string;
  ticker: string;
  quantity: number;
  buyPrice: number;
  currentPrice: number;
  createdAt: string;
}

export interface PendingPayment {
  id: string;
  sourceType: "subscription" | "fixed";
  sourceId: string;
  name: string;
  amount: number;
  category: string;
  dueDate: string;
  createdAt: string;
  status?: "pending" | "skipped" | "confirmed";
  skippedCount?: number;
  lastSkippedDate?: string | null;
  carryOverAmount?: number; // Добавлено поле
}

export interface SkippedPayment {
  id: string;
  sourceId: string;
  sourceType: "subscription" | "fixed";
  originalAmount: number;
  skippedDate: string;
  dueDate: string;
  carryOver: boolean;
  carriedAmount: number;
}

export interface AppData {
  transactions: Transaction[];
  subscriptions: Subscription[];
  fixedPayments: FixedPayment[];
  budgets: Budget[];
  goals: Goal[];
  investments: Investment[];
  pendingPayments: PendingPayment[];
  skippedPayments?: SkippedPayment[];
  currency: Currency;
  theme: Theme;
  fontScale: number;
}

export interface Toast {
  id: string;
  text: string;
  kind: "success" | "error" | "info";
}

export interface Category {
  id: string;
  label: string;
  type: TxType;
  color: string;
  icon: string;
}
