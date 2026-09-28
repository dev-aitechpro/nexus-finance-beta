// src/hooks/useKeyboard.ts
import { useEffect } from 'react';

interface KeyboardShortcut {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  handler: () => void;
  preventDefault?: boolean;
}

export function useKeyboardShortcuts(shortcuts: KeyboardShortcut[]) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      for (const shortcut of shortcuts) {
        const match = 
          e.key === shortcut.key &&
          (shortcut.ctrl === undefined || e.ctrlKey === shortcut.ctrl) &&
          (shortcut.shift === undefined || e.shiftKey === shortcut.shift) &&
          (shortcut.alt === undefined || e.altKey === shortcut.alt) &&
          (shortcut.meta === undefined || e.metaKey === shortcut.meta);
        
        if (match) {
          if (shortcut.preventDefault !== false) {
            e.preventDefault();
          }
          shortcut.handler();
          break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts]);
}import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { buildSeed, emptyData, generatePending, isReached } from "../lib/engine";
import { mergeData, parseImport, serializeExport, storageService } from "../lib/storage";
import type {
  AppData, Currency, FixedPayment, Goal, Investment, Subscription, Tab, Theme,
  Toast, Transaction, TransactionInput,
} from "../lib/types";
import { downloadFile, formatNumber, todayISO, uid } from "../lib/utils";

export interface TxModalState {
  open: boolean;
  editing: Transaction | null;
  preset: Partial<TransactionInput>;
}

interface AppContextValue {
  data: AppData;
  tab: Tab;
  go: (t: Tab) => void;
  toasts: Toast[];
  notify: (text: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: string) => void;
  txModal: TxModalState;
  openTxModal: (editing?: Transaction | null, preset?: Partial<TransactionInput>) => void;
  closeTxModal: () => void;

  addTransaction: (input: TransactionInput) => void;
  updateTransaction: (id: string, input: TransactionInput) => void;
  deleteTransaction: (id: string) => void;

  saveSubscription: (s: Subscription) => void;
  deleteSubscription: (id: string) => void;
  saveFixedPayment: (f: FixedPayment) => void;
  deleteFixedPayment: (id: string) => void;
  confirmPayment: (pendingId: string, amount: number) => void;
  skipPayment: (pendingId: string) => void;

  setBudget: (category: string, limit: number) => void;
  deleteBudget: (id: string) => void;

  saveGoal: (g: Goal) => void;
  deleteGoal: (id: string) => void;
  fundGoal: (id: string, amount: number) => void;

  saveInvestment: (i: Investment) => void;
  deleteInvestment: (id: string) => void;
  tickPrices: () => void;

  setTheme: (t: Theme) => void;
  setCurrency: (c: Currency) => void;
  setFontScale: (s: number) => void;

  exportNow: () => void;
  importFromText: (text: string) => string;
  clearAll: () => void;
  loadDemo: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AppData>(() => storageService.load() ?? buildSeed());
  const [tab, setTab] = useState<Tab>("dashboard");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [txModal, setTxModal] = useState<TxModalState>({ open: false, editing: null, preset: {} });

  const dataRef = useRef(data);
  dataRef.current = data;
  const saveTimer = useRef<number | null>(null);

  const notify = useCallback((text: string, kind: Toast["kind"] = "success") => {
    const id = uid();
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  /* Дебаунс сохранения — 500 мс (ТЗ 8.1) */
  useEffect(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => storageService.save(data), 500);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [data]);

  /* Тема и масштаб шрифта */
  useEffect(() => {
    document.documentElement.dataset.theme = data.theme;
  }, [data.theme]);

  useEffect(() => {
    document.documentElement.style.fontSize = `${data.fontScale * 100}%`;
  }, [data.fontScale]);

  /* Автогенерация pending-платежей */
  useEffect(() => {
    setData((d) => {
      const next = generatePending(d.subscriptions, d.fixedPayments, d.pendingPayments);
      return next.length === d.pendingPayments.length ? d : { ...d, pendingPayments: next };
    });
  }, [data.subscriptions, data.fixedPayments]);

  const go = useCallback((t: Tab) => {
    setTab(t);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  /* ── Транзакции ── */

  const addTransaction = useCallback((input: TransactionInput) => {
    const tx: Transaction = {
      id: uid(), ...input, status: "confirmed", sourceId: null,
      createdAt: new Date().toISOString(),
    };
    setData((d) => ({ ...d, transactions: [...d.transactions, tx] }));
    notify(input.type === "income" ? "Доход добавлен" : "Расход добавлен");
  }, [notify]);

  const updateTransaction = useCallback((id: string, input: TransactionInput) => {
    setData((d) => ({
      ...d,
      transactions: d.transactions.map((t) => (t.id === id ? { ...t, ...input } : t)),
    }));
    notify("Транзакция обновлена");
  }, [notify]);

  const deleteTransaction = useCallback((id: string) => {
    setData((d) => ({ ...d, transactions: d.transactions.filter((t) => t.id !== id) }));
    notify("Транзакция удалена", "info");
  }, [notify]);

  /* ── Подписки и фиксированные платежи ── */

  const saveSubscription = useCallback((s: Subscription) => {
    setData((d) => {
      const exists = d.subscriptions.some((x) => x.id === s.id);
      return {
        ...d,
        subscriptions: exists
          ? d.subscriptions.map((x) => (x.id === s.id ? s : x))
          : [...d.subscriptions, s],
      };
    });
    notify("Подписка сохранена");
  }, [notify]);

  const deleteSubscription = useCallback((id: string) => {
    setData((d) => ({
      ...d,
      subscriptions: d.subscriptions.filter((x) => x.id !== id),
      pendingPayments: d.pendingPayments.filter((p) => p.sourceId !== id),
    }));
    notify("Подписка удалена вместе с ожидающими платежами", "info");
  }, [notify]);

  const saveFixedPayment = useCallback((f: FixedPayment) => {
    setData((d) => {
      const exists = d.fixedPayments.some((x) => x.id === f.id);
      return {
        ...d,
        fixedPayments: exists
          ? d.fixedPayments.map((x) => (x.id === f.id ? f : x))
          : [...d.fixedPayments, f],
      };
    });
    notify("Платёж сохранён");
  }, [notify]);

  const deleteFixedPayment = useCallback((id: string) => {
    setData((d) => ({
      ...d,
      fixedPayments: d.fixedPayments.filter((x) => x.id !== id),
      pendingPayments: d.pendingPayments.filter((p) => p.sourceId !== id),
    }));
    notify("Платёж удалён вместе с ожидающими платежами", "info");
  }, [notify]);

  /* ── Подтверждение / пропуск платежей ── */

  const confirmPayment = useCallback((pendingId: string, amount: number) => {
    const p = dataRef.current.pendingPayments.find((x) => x.id === pendingId);
    if (!p || amount <= 0) return;
    const tx: Transaction = {
      id: uid(), type: "expense", category: p.category, amount,
      description: p.name, date: todayISO(),
      source: p.sourceType === "subscription" ? "subscription" : "payment",
      status: "confirmed", sourceId: p.sourceId, createdAt: new Date().toISOString(),
    };
    setData((d) => ({
      ...d,
      transactions: [...d.transactions, tx],
      subscriptions: p.sourceType === "subscription"
        ? d.subscriptions.map((s) => (s.id === p.sourceId ? { ...s, lastConfirmed: p.dueDate } : s))
        : d.subscriptions,
      fixedPayments: p.sourceType === "fixed"
        ? d.fixedPayments.map((f) => (f.id === p.sourceId ? { ...f, lastConfirmed: p.dueDate } : f))
        : d.fixedPayments,
      pendingPayments: d.pendingPayments.filter((x) => x.id !== pendingId),
    }));
    notify(`Платёж «${p.name}» подтверждён: ${formatNumber(amount, dataRef.current.currency)}`);
  }, [notify]);

  const skipPayment = useCallback((pendingId: string) => {
    const p = dataRef.current.pendingPayments.find((x) => x.id === pendingId);
    if (!p) return;
    const tx: Transaction = {
      id: uid(), type: "expense", category: p.category, amount: p.amount,
      description: p.name, date: p.dueDate,
      source: p.sourceType === "subscription" ? "subscription" : "payment",
      status: "skipped", sourceId: p.sourceId, createdAt: new Date().toISOString(),
    };
    setData((d) => ({
      ...d,
      transactions: [...d.transactions, tx],
      subscriptions: p.sourceType === "subscription"
        ? d.subscriptions.map((s) => (s.id === p.sourceId ? { ...s, lastConfirmed: p.dueDate } : s))
        : d.subscriptions,
      fixedPayments: p.sourceType === "fixed"
        ? d.fixedPayments.map((f) => (f.id === p.sourceId ? { ...f, lastConfirmed: p.dueDate } : f))
        : d.fixedPayments,
      pendingPayments: d.pendingPayments.filter((x) => x.id !== pendingId),
    }));
    notify(`«${p.name}» пропущен и перенесён на следующий месяц`, "info");
  }, [notify]);

  /* ── Бюджеты ── */

  const setBudget = useCallback((category: string, limit: number) => {
    setData((d) => {
      const existing = d.budgets.find((b) => b.category === category);
      if (existing) {
        return { ...d, budgets: d.budgets.map((b) => (b.category === category ? { ...b, limit } : b)) };
      }
      return {
        ...d,
        budgets: [...d.budgets, { id: uid(), category, limit, createdAt: new Date().toISOString() }],
      };
    });
    notify("Лимит бюджета сохранён");
  }, [notify]);

  const deleteBudget = useCallback((id: string) => {
    setData((d) => ({ ...d, budgets: d.budgets.filter((b) => b.id !== id) }));
    notify("Бюджет удалён", "info");
  }, [notify]);

  /* ── Цели ── */

  const saveGoal = useCallback((g: Goal) => {
    setData((d) => {
      const exists = d.goals.some((x) => x.id === g.id);
      return { ...d, goals: exists ? d.goals.map((x) => (x.id === g.id ? g : x)) : [...d.goals, g] };
    });
    notify("Цель сохранена");
  }, [notify]);

  const deleteGoal = useCallback((id: string) => {
    setData((d) => ({ ...d, goals: d.goals.filter((g) => g.id !== id) }));
    notify("Цель удалена", "info");
  }, [notify]);

  const fundGoal = useCallback((id: string, amount: number) => {
    const g = dataRef.current.goals.find((x) => x.id === id);
    if (!g || amount <= 0) return;
    const wasReached = isReached(g);
    const tx: Transaction = {
      id: uid(), type: "expense", category: "savings", amount,
      description: `Пополнение: ${g.name}`, date: todayISO(),
      source: "goal", status: "confirmed", sourceId: g.id,
      createdAt: new Date().toISOString(),
    };
    setData((d) => ({
      ...d,
      transactions: [...d.transactions, tx],
      goals: d.goals.map((x) => (x.id === id ? { ...x, savedAmount: x.savedAmount + amount } : x)),
    }));
    if (!wasReached && isReached({ ...g, savedAmount: g.savedAmount + amount })) {
      notify(`Цель «${g.name}» достигнута — поздравляем!`);
    } else {
      notify(`Цель пополнена на ${formatNumber(amount, dataRef.current.currency)}`);
    }
  }, [notify]);

  /* ── Инвестиции ── */

  const saveInvestment = useCallback((i: Investment) => {
    setData((d) => {
      const exists = d.investments.some((x) => x.id === i.id);
      return {
        ...d,
        investments: exists
          ? d.investments.map((x) => (x.id === i.id ? i : x))
          : [...d.investments, i],
      };
    });
    notify("Актив сохранён");
  }, [notify]);

  const deleteInvestment = useCallback((id: string) => {
    setData((d) => ({ ...d, investments: d.investments.filter((i) => i.id !== id) }));
    notify("Актив удалён", "info");
  }, [notify]);

  const tickPrices = useCallback(() => {
    setData((d) => ({
      ...d,
      investments: d.investments.map((i) => ({
        ...i,
        currentPrice: Math.max(0.01, Math.round(i.currentPrice * (1 + (Math.random() - 0.5) * 0.016) * 100) / 100),
      })),
    }));
  }, []);

  /* ── Настройки и данные ── */

  const setTheme = useCallback((t: Theme) => setData((d) => ({ ...d, theme: t })), []);
  const setCurrency = useCallback((c: Currency) => setData((d) => ({ ...d, currency: c })), []);
  const setFontScale = useCallback((s: number) => setData((d) => ({ ...d, fontScale: s })), []);

  const exportNow = useCallback(() => {
    downloadFile(`nexus-finance-${todayISO()}.json`, serializeExport(dataRef.current));
    notify("Файл бэкапа сохранён");
  }, [notify]);

  const importFromText = useCallback((text: string): string => {
    try {
      const incoming = parseImport(text);
      const before = dataRef.current.transactions.length;
      setData((d) => mergeData(d, incoming));
      const added = incoming.transactions.length;
      notify(`Импорт завершён: транзакций в файле ${added}, всего было ${before}`);
      return "ok";
    } catch (e) {
      notify((e as Error).message, "error");
      return "error";
    }
  }, [notify]);

  const clearAll = useCallback(() => {
    storageService.clear();
    setData(emptyData());
    notify("Все данные удалены", "info");
  }, [notify]);

  const loadDemo = useCallback(() => {
    setData(buildSeed());
    notify("Демо-данные загружены");
  }, [notify]);

  const openTxModal = useCallback((editing: Transaction | null = null, preset: Partial<TransactionInput> = {}) => {
    setTxModal({ open: true, editing, preset });
  }, []);

  const closeTxModal = useCallback(() => setTxModal({ open: false, editing: null, preset: {} }), []);

  const value = useMemo<AppContextValue>(() => ({
    data, tab, go, toasts, notify, dismissToast, txModal, openTxModal, closeTxModal,
    addTransaction, updateTransaction, deleteTransaction,
    saveSubscription, deleteSubscription, saveFixedPayment, deleteFixedPayment,
    confirmPayment, skipPayment, setBudget, deleteBudget,
    saveGoal, deleteGoal, fundGoal,
    saveInvestment, deleteInvestment, tickPrices,
    setTheme, setCurrency, setFontScale,
    exportNow, importFromText, clearAll, loadDemo,
  }), [
    data, tab, go, toasts, notify, dismissToast, txModal, openTxModal, closeTxModal,
    addTransaction, updateTransaction, deleteTransaction,
    saveSubscription, deleteSubscription, saveFixedPayment, deleteFixedPayment,
    confirmPayment, skipPayment, setBudget, deleteBudget,
    saveGoal, deleteGoal, fundGoal,
    saveInvestment, deleteInvestment, tickPrices,
    setTheme, setCurrency, setFontScale,
    exportNow, importFromText, clearAll, loadDemo,
  ]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
