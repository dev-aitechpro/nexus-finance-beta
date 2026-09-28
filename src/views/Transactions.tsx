// src/views/Transactions.tsx
import {
  ArrowLeftRight, CalendarDays, Check, ChevronLeft, ChevronRight, Pencil,
  Plus, Search, SkipForward, Trash2, X, Circle, CheckCircle2,
} from "lucide-react";
// KeyboardEvent импортируем под другим именем: в этом же файле используется
// DOM-тип KeyboardEvent в window.addEventListener, и одноимённый импорт из
// react его перекрывает.
import { useEffect, useMemo, useState, useCallback, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useApp } from "../hooks/AppProvider";
import { useOverlay } from "../hooks/useOverlayStack";
import {
  CategoryHex, ConfirmDialog, EmptyState, PageHeader, Segmented, StatusBadge,
} from "../components/ui";
import { TransactionSelection } from "../components/TransactionSelection";
import { txStatusFromPending } from "../lib/engine";
import { CATEGORIES, categoryById, PAGE_SIZE, SOURCE_LABELS } from "../lib/constants";
import { isActionablePending } from "../lib/engine";
import type { Transaction, TxSource, TxStatus, TxType } from "../lib/types";
import {
  formatDate, formatNumber, todayISO, plural,
} from "../lib/utils";

type TypeFilter = "all" | TxType;
type StatusFilter = "all" | TxStatus;
type SourceFilter = "all" | TxSource;

const monthAgoISO = (n: number): string => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
};

export function Transactions() {
  const { data, openTxModal, deleteTransaction, deleteSelectedTransactions, confirmPayment, skipPayment } = useApp();
  const currency = data.currency;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [type, setType] = useState<TypeFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [source, setSource] = useState<SourceFilter>("all");
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sortDesc, setSortDesc] = useState(true);
  const [page, setPage] = useState(1);
  const [toDelete, setToDelete] = useState<Transaction | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(true);

  // Клавиатурные сокращения
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+F для поиска
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        const searchInput = document.querySelector('input[placeholder="Поиск по описанию или категории…"]');
        if (searchInput instanceof HTMLElement) {
          searchInput.focus();
        }
      }
      
      // Escape для сброса выделения
      if (e.key === 'Escape') {
        // Сброс выделения: панель берёт состояние отсюда, отдельного события
        // больше не нужно — раньше оно расходилось с состоянием экрана.
        setSelectedIds(new Set());
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  /** Операция из регулярного платежа: удаляем её иначе, с пояснением. */
  const toDeleteIsSource =
    toDelete !== null &&
    (toDelete.source === "subscription" || toDelete.source === "payment") &&
    !!toDelete.sourceId;

  const merged = useMemo<Transaction[]>(() => {
    // В журнал попадают только те регулярные платежи, по которым нужно
    // действие сейчас. Платёж следующего месяца (создаётся заранее, чтобы не
    // потерять пропущенный месяц) — это план, а не запись журнала: раньше он
    // появлялся здесь строкой со статусом «ожидает» и требовал подтверждения.
    const pendingTx = data.pendingPayments
      .filter((p) => isActionablePending(p))
      .map(txStatusFromPending);
    return [...data.transactions, ...pendingTx];
  }, [data.transactions, data.pendingPayments]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = merged.filter((t) => {
      if (type !== "all" && t.type !== type) return false;
      if (status !== "all" && t.status !== status) return false;
      if (source !== "all" && t.source !== source) return false;
      if (category !== "all" && t.category !== category) return false;
      if (from && t.date < from) return false;
      if (to && t.date > to) return false;
      if (q) {
        const hay = `${t.description ?? ""} ${categoryById(t.category).label}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    list.sort((a, b) => {
      const cmp = a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt);
      return sortDesc ? -cmp : cmp;
    });
    return list;
  }, [merged, type, status, source, category, search, from, to, sortDesc]);

  useEffect(() => {
    setPage(1);
  }, [type, status, source, category, search, from, to]);

  // Очищаем выделение при изменении фильтров
  useEffect(() => {
    setSelectedIds(new Set());
  }, [type, status, source, category, search, from, to]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const slice = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const hasFilters =
    type !== "all" || status !== "all" || source !== "all" || category !== "all" ||
    search !== "" || from !== "" || to !== "";

  const reset = useCallback(() => {
    setType("all"); setStatus("all"); setSource("all"); setCategory("all");
    setSearch(""); setFrom(""); setTo("");
    setSelectedIds(new Set());
  }, []);

  const quickPeriod = useCallback((months: number | null) => {
    if (months === null) { setFrom(""); setTo(""); }
    else { setFrom(monthAgoISO(months - 1)); setTo(todayISO()); }
  }, []);

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  }, []);

  // Операции, доступные для массового выделения: только подтверждённые
  // (платежи в ожидании выбирать нельзя — их подтверждают или пропускают).
  const selectableIds = useMemo(
    () => merged.filter((t) => t.status === "confirmed").map((t) => t.id),
    [merged],
  );

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const selectAll = useCallback(() => setSelectedIds(new Set(selectableIds)), [selectableIds]);

  /**
   * Аппаратная кнопка «Назад» в журнале. Диалоги здесь на Modal (подтверждение
   * удаления строки и «Удалить выбранные»), их закрывает стек оверлеев сам.
   * А раскрытые фильтры и выделение стек не ловит: это не оверлей, а состояние
   * экрана — и уходит оно вместе с компонентом при смене вкладки, то есть
   * введённый поиск просто пропадает. Поэтому «Назад» по убыванию важности:
   *   1) снимает выделение (как Escape на десктопе — см. обработчик клавиш выше);
   *   2) сбрасывает применённые фильтры (тот же reset, что у кнопки «Сброс»);
   *   3) убирает раскрытую панель фильтров.
   * Когда всего этого нет, нажатие уходит дальше по цепочке App.tsx, то есть
   * на «Обзор»: пустой журнал сворачивается, не теряя набранного.
   */
  useOverlay(
    selectedIds.size > 0 || hasFilters || filtersOpen,
    () => {
      if (selectedIds.size > 0) {
        clearSelection();
        return;
      }
      if (hasFilters) {
        reset();
        return;
      }
      setFiltersOpen(false);
    },
  );

  const incomeSum = filtered.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const expenseSum = filtered.filter((t) => t.type === "expense" && t.status !== "skipped").reduce((s, t) => s + t.amount, 0);

  // Обработчик клавиши Enter для поиска
  const handleSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
    }
  };

  return (
    <div>
      <PageHeader
        kicker="Журнал операций"
        title="Транзакции"
        actions={<button className="btn btn-primary" onClick={() => openTxModal()}><Plus size={15} /> Новая транзакция</button>}
      />

      {/* Фильтры */}
      <section className="card cut p-4 mb-5 rise-in" aria-label="Фильтры">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--muted)" }} />
            <input
              className="input pl-9"
              placeholder="Поиск по описанию или категории…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              aria-label="Поиск транзакций"
            />
          </div>
          <Segmented<TypeFilter>
            options={[
              { value: "all", label: "Все" },
              { value: "income", label: "Доходы" },
              { value: "expense", label: "Расходы" },
            ]}
            value={type}
            onChange={setType}
          />
          <button className="btn btn-ghost btn-sm" onClick={() => setFiltersOpen((v) => !v)} aria-expanded={filtersOpen}>
            <CalendarDays size={14} /> Фильтры
          </button>
          {hasFilters && (
            <button className="btn btn-ghost btn-sm" onClick={reset}><X size={13} /> Сброс</button>
          )}
        </div>

        {filtersOpen && (
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-4 pt-4 border-t" style={{ borderColor: "var(--line)" }}>
            <label className="block">
              <span className="field-label">Категория</span>
              <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="all">Все категории</option>
                <optgroup label="Доходы">
                  {CATEGORIES.filter((c) => c.type === "income").map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </optgroup>
                <optgroup label="Расходы">
                  {CATEGORIES.filter((c) => c.type === "expense").map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </optgroup>
              </select>
            </label>
            <label className="block">
              <span className="field-label">Источник</span>
              <select className="input" value={source} onChange={(e) => setSource(e.target.value as SourceFilter)}>
                <option value="all">Все источники</option>
                <option value="manual">Ручная</option>
                <option value="subscription">Подписка</option>
                <option value="payment">Платёж</option>
                <option value="goal">Цель</option>
              </select>
            </label>
            <label className="block">
              <span className="field-label">Статус</span>
              <select className="input" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
                <option value="all">Все статусы</option>
                <option value="confirmed">Подтверждён</option>
                <option value="pending">Ожидает</option>
                <option value="skipped">Пропущен</option>
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="field-label">С даты</span>
                <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label className="block">
                <span className="field-label">По дату</span>
                <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
            </div>
            <div className="sm:col-span-2 lg:col-span-4 flex flex-wrap gap-2">
              <button className="chip" onClick={() => quickPeriod(1)}>Этот месяц</button>
              <button className="chip" onClick={() => quickPeriod(3)}>3 месяца</button>
              <button className="chip" onClick={() => quickPeriod(12)}>Год</button>
              <button className="chip" onClick={() => quickPeriod(null)}>Всё время</button>
              <span className="ml-auto text-xs self-center mono" style={{ color: "var(--muted)" }}>
                {filtered.length} {plural(filtered.length, "операция", "операции", "операций")}
              </span>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3 text-xs mono" style={{ color: "var(--muted)" }}>
          <span>Доходы: <b style={{ color: "var(--ok)" }}>{formatNumber(incomeSum, currency)}</b></span>
          <span>Расходы: <b style={{ color: "var(--pink)" }}>{formatNumber(expenseSum, currency)}</b></span>
          <span>Итог: <b style={{ color: "var(--text)" }}>{formatNumber(incomeSum - expenseSum, currency)}</b></span>
        </div>
      </section>

      {/* Панель массовых операций: получает выделение от журнала */}
      <TransactionSelection
        selectedIds={selectedIds}
        total={selectableIds.length}
        onClear={clearSelection}
        onSelectAll={selectAll}
        onDelete={(ids) => { deleteSelectedTransactions(ids); clearSelection(); }}
      />

      {/* Журнал */}
      <section className="card cut overflow-hidden rise-in" style={{ animationDelay: "80ms" }}>
        <div className="jhead" aria-hidden>
          <button className="jhead-sort" onClick={() => setSortDesc((v) => !v)}>
            Дата {sortDesc ? "↓" : "↑"}
          </button>
          <span>Категория</span>
          <span>Описание</span>
          <span>Источник</span>
          <span>Статус</span>
          <span className="text-right">Сумма</span>
          <span />
        </div>

        {slice.length === 0 ? (
          <EmptyState
            icon={ArrowLeftRight}
            title="Ничего не найдено"
            text={hasFilters ? "Попробуйте смягчить фильтры или сбросить их." : "Добавьте первую транзакцию — журнал заполнится."}
            action={hasFilters
              ? <button className="btn btn-ghost" onClick={reset}>Сбросить фильтры</button>
              : <button className="btn btn-primary" onClick={() => openTxModal()}><Plus size={15} /> Добавить</button>}
          />
        ) : (
          <ul>
            {slice.map((t) => (
              <li 
                key={t.id} 
                className={`jrow ${selectedIds.has(t.id) ? 'selected' : ''}`}
                tabIndex={0}
                role="row"
                onClick={() => {
                  if (t.status === 'confirmed') {
                    toggleSelection(t.id);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && t.status === 'confirmed') {
                    openTxModal(t);
                  }
                  if (e.key === ' ' && t.status === 'confirmed') {
                    e.preventDefault();
                    toggleSelection(t.id);
                  }
                }}
                style={{
                  backgroundColor: selectedIds.has(t.id) ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent',
                  borderLeft: selectedIds.has(t.id) ? `3px solid var(--accent)` : 'none',
                }}
              >
                <span className="jcell-date mono">{formatDate(t.date)}</span>
                <span className="jcell-cat">
                  {t.status === 'confirmed' ? (
                    <span
                      className="mr-2 cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSelection(t.id);
                      }}
                      aria-label={selectedIds.has(t.id) ? "Снять выделение" : "Выделить транзакцию"}
                    >
                      {selectedIds.has(t.id) ? (
                        <CheckCircle2 size={18} style={{ color: "var(--accent)" }} />
                      ) : (
                        <Circle size={18} style={{ color: "var(--muted)" }} />
                      )}
                    </span>
                  ) : (
                    /* Для платежей в ожидании чекбокс недоступен, но место под него
                       резервируем: иначе иконка категории и подпись в таких строках
                       сдвигались влево на 36px и строки выглядели невыровненными. */
                    <span className="mr-2" style={{ width: 18, height: 18, flex: "none" }} aria-hidden="true" />
                  )}
                  <CategoryHex id={t.category} size={32} />
                  <span className="text-sm truncate" style={{ color: "var(--text)" }}>{categoryById(t.category).label}</span>
                </span>
                <span className="jcell-desc text-sm truncate" style={{ color: t.description ? "var(--text)" : "var(--muted)" }}>
                  {t.description ?? "—"}
                </span>
                <span className="jcell-src text-xs" style={{ color: "var(--muted)" }}>{SOURCE_LABELS[t.source]}</span>
                <span className="jcell-status"><StatusBadge status={t.status} /></span>
                <span
                  className="jcell-amount mono font-semibold"
                  style={{
                    color: t.status === "skipped" ? "var(--muted)" : t.type === "income" ? "var(--ok)" : "var(--pink)",
                    textDecoration: t.status === "skipped" ? "line-through" : "none",
                  }}
                >
                  {t.type === "income" ? "+" : "−"}{formatNumber(t.amount, currency)}
                </span>
                <span className="jcell-actions">
                  {t.status === "pending" ? (
                    <>
                      <button className="btn-icon btn-icon-ok" title="Подтвердить платёж" aria-label="Подтвердить" onClick={() => confirmPayment(t.id, t.amount)}><Check size={15} /></button>
                      <button className="btn-icon" title="Пропустить платёж" aria-label="Пропустить" onClick={() => skipPayment(t.id, false)}><SkipForward size={15} /></button>
                    </>
                  ) : (
                    <>
                      {t.status === "confirmed" && (
                        <button className="btn-icon" title="Редактировать" aria-label="Редактировать" onClick={() => openTxModal(t)}><Pencil size={14} /></button>
                      )}
                      <button
                        className="btn-icon btn-icon-danger"
                        title="Удалить"
                        aria-label="Удалить операцию"
                        onClick={() => setToDelete(t)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {pages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t" style={{ borderColor: "var(--line)" }}>
            <span className="text-xs mono" style={{ color: "var(--muted)" }}>
              {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} из {filtered.length}
            </span>
            <div className="flex items-center gap-2">
              <button className="btn-icon" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage === 1} aria-label="Предыдущая страница">
                <ChevronLeft size={16} />
              </button>
              {Array.from({ length: pages }, (_, i) => i + 1)
                .filter((p) => p === 1 || p === pages || Math.abs(p - safePage) <= 1)
                .map((p, idx, arr) => (
                  <span key={p} className="flex items-center gap-2">
                    {idx > 0 && arr[idx - 1] !== p - 1 && <span style={{ color: "var(--muted)" }}>…</span>}
                    <button
                      className={p === safePage ? "page-btn page-btn-active" : "page-btn"}
                      onClick={() => setPage(p)}
                      aria-current={p === safePage ? "page" : undefined}
                    >
                      {p}
                    </button>
                  </span>
                ))}
              <button className="btn-icon" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={safePage === pages} aria-label="Следующая страница">
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </section>

      {/*
        Подтверждение удаления. Для ручных операций — короткий вопрос, чтобы не
        снести запись по опечатке. Для операций из подписки/платежа — с пояснением
        последствий и вторым вариантом: удалить саму подписку, если она создана
        случайно. Раньше удаление молча возвращало запись к подтверждению.
      */}
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        title={toDeleteIsSource ? "Удалить запись о регулярном платеже?" : "Удалить операцию?"}
        text={toDeleteIsSource
          ? `«${toDelete?.description ?? categoryById(toDelete?.category ?? "").label}» — запись из регулярного платежа. ` +
            `Запись удалится, а этот месяц будет закрыт: заново подтверждать его не спросят. ` +
            `Если платёж создан по ошибке и повторяться не должен — удалите сам регулярный платёж во вкладке «Платежи».`
          : "Операция будет удалена безвозвратно. Отменить это действие нельзя."}
        confirmLabel={toDeleteIsSource ? "Удалить запись" : "Удалить"}
        onConfirm={() => {
          if (toDelete) deleteTransaction(toDelete.id, false);
          setToDelete(null);
        }}
      />
    </div>
  );
}