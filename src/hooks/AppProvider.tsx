// src/hooks/AppProvider.tsx
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { buildSeed, emptyData, generatePending, isReached, confirmPaymentWithAmount, skipPaymentWithCarry, deleteTransactionCompletely, deletePaymentSourceCompletely, deleteSourceAndCarryNextMonth } from "../lib/engine";
import { mergeData, parseImport, serializeExport, storageService } from "../lib/storage";
import type {
  AppData, Currency, FixedPayment, Goal, Investment, Subscription, Tab, Theme,
  Toast, Transaction, TransactionInput,
} from "../lib/types";
import { formatNumber, todayISO, uid, monthKey, parseISO } from "../lib/utils";
import { platform } from "../platform";

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
  /** withSource = true удаляет вместе с операцией регулярный платёж. */
  deleteTransaction: (id: string, withSource?: boolean) => void;
  deleteSelectedTransactions: (ids: string[]) => void;

  saveSubscription: (s: Subscription) => void;
  deleteSubscription: (id: string) => void;
  /** Удаление регулярного платежа с выбором: перенести на месяц / оставить записи / удалить всё. */
  deleteRecurringSource: (kind: "sub" | "fixed", id: string, mode: "carry" | "keep" | "all") => void;
  /** Убрать запланированный платёж из раздела «Запланировано». */
  removePending: (id: string) => void;
  saveFixedPayment: (f: FixedPayment) => void;
  deleteFixedPayment: (id: string) => void;
  confirmPayment: (pendingId: string, amount: number) => void;
  skipPayment: (pendingId: string, carryOver: boolean) => void;

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

  exportNow: () => Promise<void>;
  importFromText: (text: string) => string;
  /** Импорт из файла: диалог выбирает мост платформы, а не сама страница. */
  importFromFile: () => Promise<void>;
  clearAll: () => Promise<void>;
  /** Повторная попытка чтения базы после ошибки загрузки. */
  retryLoad: () => Promise<void>;
  /** true, если база не прочиталась и сохранение заблокировано. */
  loadBlocked: boolean;
  loadDemo: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  // 🔥 Инициализируем пустыми данными, а не результатом асинхронного вызова
  const [data, setData] = useState<AppData>(() => emptyData());
  const [tab, setTab] = useState<Tab>("dashboard");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [txModal, setTxModal] = useState<TxModalState>({ open: false, editing: null, preset: {} });
  const [isLoading, setIsLoading] = useState(true);

  const dataRef = useRef(data);
  dataRef.current = data;
  const saveTimer = useRef<number | null>(null);

  // 🔥 Загружаем данные при первом рендере (асинхронно)
  //
  // loadBlocked — защита от потери данных: если база не прочиталась,
  // нельзя ни подставлять демо-данные, ни запускать автосохранение,
  // иначе «ошибка чтения» превратилась бы в «перезапись базы демо».
  const [loadBlocked, setLoadBlocked] = useState(false);

  useEffect(() => {
    const loadData = async () => {
      try {
        const loaded = await storageService.load();
        if (loaded && !loaded.skippedPayments) {
          setData({ ...loaded, skippedPayments: [] });
        } else if (loaded) {
          setData(loaded);
        } else {
          setData(buildSeed());
        }
      } catch (e) {
        // Данные целы, до них просто не дошли. Оставляем пустое состояние,
        // блокируем сохранение и один раз сообщаем пользователю.
        console.error("Ошибка загрузки данных:", e);
        setData(emptyData());
        setLoadBlocked(true);
        setToasts((t) => [
          ...t,
          {
            id: uid(),
            kind: "error",
            text: `Не удалось прочитать базу: ${storageService.loadError() ?? "неизвестная ошибка"}. Данные не перезаписаны.`,
          },
        ]);
      } finally {
        setIsLoading(false);
      }
    };
    void loadData();
  }, []);

  /** Повторная попытка загрузки после устранения причины сбоя. */
  const retryLoad = useCallback(async () => {
    setIsLoading(true);
    try {
      const loaded = await storageService.load();
      setLoadBlocked(false);
      setData(loaded ?? buildSeed());
    } catch (e) {
      console.error("Повторная загрузка не удалась:", e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const notify = useCallback((text: string, kind: Toast["kind"] = "success") => {
    const id = uid();
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  /* Дебаунс сохранения — 500 мс (асинхронный) */
  useEffect(() => {
    if (isLoading) return;
    // Пока база не прочитана, сохранять нельзя: иначе демо-пустое состояние
    // затёрло бы реальные данные.
    if (loadBlocked) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      await storageService.save(data);
    }, 500);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [data, isLoading, loadBlocked]);

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
      const next = generatePending(d.subscriptions, d.fixedPayments, d.pendingPayments, d.skippedPayments || []);
      
      const currentMonthKey = monthKey(new Date());
      const updatedSkippedPayments = (d.skippedPayments || []).filter(
        (sp) => !(monthKey(parseISO(sp.dueDate)) === currentMonthKey && sp.carryOver)
      );
      
      if (next.length !== d.pendingPayments.length || 
          next.some((p, i) => p.amount !== d.pendingPayments[i]?.amount) ||
          updatedSkippedPayments.length !== (d.skippedPayments || []).length) {
        return {
          ...d,
          pendingPayments: next,
          skippedPayments: updatedSkippedPayments,
        };
      }
      return d;
    });
  }, [data.subscriptions, data.fixedPayments, data.skippedPayments, data.pendingPayments]);

  const go = useCallback((t: Tab) => {
    setTab(t);
    // Прокручивается не окно, а <main class="app-main">: корневой контейнер
    // имеет h-screen + overflow-hidden, поэтому window.scrollTo был no-op, и
    // при переходе на вкладку из 3–5 экранов пользователь оказывался в
    // середине с сохранённой позицией предыдущей вкладки.
    requestAnimationFrame(() => {
      document.querySelector(".app-main")?.scrollTo({ top: 0, behavior: "smooth" });
    });
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

  /**
   * Удаление операции.
   *
   * Раньше для операций из подписки или регулярного платежа удаление не
   * удаляло, а возвращало запись к подтверждению: строка «вылезала» обратно,
   * потому что lastConfirmed сбрасывался в null и генератор снова создавал
   * платёж на этот месяц. Теперь удаление настоящее, а месяц закрывается датой
   * удалённой операции — повторно этот месяц не спросят.
   *
   * withSource = true удаляет вместе с операцией сам регулярный платёж
   * и все его записи (для ошибочно созданной подписки).
   */
  const deleteTransaction = useCallback((id: string, withSource = false) => {
    const tx = dataRef.current.transactions.find((t) => t.id === id);
    if (!tx) {
      notify("Операция уже удалена", "info");
      return;
    }
    if ((tx.source === "subscription" || tx.source === "payment") && tx.sourceId) {
      const sourceId = tx.sourceId;
      const sourceType = tx.source === "subscription" ? "subscription" : "fixed";
      setData((d) =>
        withSource
          ? deletePaymentSourceCompletely(sourceType, sourceId, d)
          : deleteTransactionCompletely(id, d),
      );
      notify(
        withSource
          ? "Операция и регулярный платёж удалены"
          : "Операция удалена, месяц закрыт — заново спрашивать не будем",
        "info",
      );
      return;
    }
    setData((d) => ({ ...d, transactions: d.transactions.filter((t) => t.id !== id) }));
    notify("Транзакция удалена", "info");
  }, [notify]);

  /**
   * Массовое удаление. Раньше для операций из подписок удалённые строки
   * возвращались к подтверждению, и выделенная группа «воскресала» целиком.
   * Теперь каждая удаляется по тем же правилам, что и одиночная, а месяцы
   * закрываются, чтобы генератор не создал их заново.
   */
  const deleteSelectedTransactions = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setData((d) => {
      let next = d;
      for (const t of d.transactions) {
        if (!ids.includes(t.id)) continue;
        next = deleteTransactionCompletely(t.id, next);
      }
      return next;
    });
    notify(`Удалено ${ids.length} ${ids.length === 1 ? "операция" : "операций"}`);
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
      skippedPayments: (d.skippedPayments || []).filter((p) => p.sourceId !== id),
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

  /**
   * Удаление регулярного платежа.
   *
   * mode = "carry" — отключаем платёж, но переносим его на следующий месяц:
   * создаётся один платёж, который попадёт в «Запланировано» и потребует
   * подтверждения, когда срок придёт.
   * mode = "keep" — удаляем источник, подтверждённые операции остаются в журнале.
   * mode = "all" — удаляем источник вместе со всеми его записями.
   */
  const deleteRecurringSource = useCallback((
    kind: "sub" | "fixed",
    id: string,
    mode: "carry" | "keep" | "all",
  ) => {
    if (mode === "keep") {
      if (kind === "sub") deleteSubscription(id);
      else deleteFixedPayment(id);
      return;
    }
    const sourceType = kind === "sub" ? "subscription" : "fixed";
    setData((d) =>
      mode === "carry"
        ? deleteSourceAndCarryNextMonth(sourceType, id, d)
        : deletePaymentSourceCompletely(sourceType, id, d),
    );
    notify(
      mode === "carry"
        ? "Платёж отключён, сумма перенесена на следующий месяц"
        : "Платёж удалён вместе со всеми записями",
      "info",
    );
  }, [notify]);

  /**
   * Убирает запланированный платёж (раздел «Запланировано»).
   *
   * Такой платёж появляется, когда регулярный платёж отключили с переносом на
   * следующий месяц. Он не является записью журнала, поэтому убрать его из
   * журнала нельзя — нужна отдельная операция, иначе он «залипает» навсегда.
   */
  const removePending = useCallback((id: string) => {
    setData((d) => ({ ...d, pendingPayments: d.pendingPayments.filter((p) => p.id !== id) }));
    notify("Запланированный платёж удалён", "info");
  }, [notify]);

  const deleteFixedPayment = useCallback((id: string) => {
    setData((d) => ({
      ...d,
      fixedPayments: d.fixedPayments.filter((x) => x.id !== id),
      pendingPayments: d.pendingPayments.filter((p) => p.sourceId !== id),
      skippedPayments: (d.skippedPayments || []).filter((p) => p.sourceId !== id),
    }));
    notify("Платёж удалён вместе с ожидающими платежами", "info");
  }, [notify]);

  /* ── Подтверждение / пропуск платежей ── */

  const confirmPayment = useCallback((pendingId: string, amount: number) => {
    try {
      const result = confirmPaymentWithAmount(pendingId, amount, dataRef.current);
      setData(result.updatedData);
      notify(`Платёж подтверждён на сумму ${formatNumber(amount, dataRef.current.currency)}`);
    } catch (error) {
      notify((error as Error).message, "error");
    }
  }, [notify]);

  const skipPayment = useCallback((pendingId: string, carryOver: boolean = false) => {
    const updatedData = skipPaymentWithCarry(pendingId, carryOver, dataRef.current);
    setData(updatedData);
    notify(carryOver ? "Платёж пропущен и будет учтён в следующем месяце" : "Платёж пропущен");
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

  const exportNow = useCallback(async () => {
    // Экспорт идёт через PlatformBridge: в Electron — нативный диалог и запись
    // файла, в веб-версии и в Android-контейнере — обычное скачивание.
    const ok = await platform().saveTextFile(`nexus-finance-${todayISO()}.json`, serializeExport(dataRef.current));
    notify(ok ? "Файл бэкапа сохранён" : "Не удалось сохранить файл", ok ? "success" : "error");
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

  const importFromFile = useCallback(async () => {
    const file = await platform().pickTextFile("application/json,.json");
    if (!file) return; // пользователь отменил выбор — тихо выходим
    importFromText(file.text);
  }, [importFromText]);

  const clearAll = useCallback(async () => {
    // Сначала дожидаемся реальной очистки базы, и только потом чистим
    // состояние: иначе отложенное автосохранение вернуло бы всё обратно
    // (раньше clear() был fire-and-forget — данные «воскресали»).
    const ok = await storageService.clear();
    if (!ok) {
      notify("Не удалось очистить базу: данные не изменены", "error");
      return;
    }
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
    addTransaction, updateTransaction, deleteTransaction, deleteSelectedTransactions,
    saveSubscription, deleteSubscription, deleteRecurringSource, saveFixedPayment, deleteFixedPayment,
    removePending,
    confirmPayment, skipPayment,
    setBudget, deleteBudget,
    saveGoal, deleteGoal, fundGoal,
    saveInvestment, deleteInvestment, tickPrices,
    setTheme, setCurrency, setFontScale,
    exportNow, importFromText, importFromFile, clearAll, loadDemo, retryLoad, loadBlocked,
  }), [
    data, tab, go, toasts, notify, dismissToast, txModal, openTxModal, closeTxModal,
    addTransaction, updateTransaction, deleteTransaction, deleteSelectedTransactions,
    saveSubscription, deleteSubscription, deleteRecurringSource, saveFixedPayment, deleteFixedPayment,
    removePending,
    confirmPayment, skipPayment,
    setBudget, deleteBudget,
    saveGoal, deleteGoal, fundGoal,
    saveInvestment, deleteInvestment, tickPrices,
    setTheme, setCurrency, setFontScale,
    exportNow, importFromText, importFromFile, clearAll, loadDemo, retryLoad, loadBlocked,
  ]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}