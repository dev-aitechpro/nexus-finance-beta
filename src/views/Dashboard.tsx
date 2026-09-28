// src/views/Dashboard.tsx
import { ArrowDownRight, ArrowUpRight, ChevronRight, Plus, Sparkles } from "lucide-react";
import { useApp } from "../hooks/AppProvider";
import { CashflowChart, DonutChart } from "../components/charts";
import { CategoryHex, EmptyState, PageHeader, ProgressBar, useAnimatedNumber } from "../components/ui";
import {
  cashflowSeries, categoryBreakdown, computeBudgetStats, isReached,
  monthTotals, portfolioStats, totals, upcomingPayments,
} from "../lib/engine";
import { categoryById, SOURCE_LABELS } from "../lib/constants";
import type { Currency } from "../lib/types";
import {
  currentMonthLabel, daysUntil, formatDateShort, formatNumber, formatPct,
  formatSigned, parseISO, percentOf, plural,
} from "../lib/utils";

function Kpi({
  label, value, currency, tone, sub, percent = false,
}: {
  label: string; value: number; currency: Currency; tone?: string; sub?: React.ReactNode; percent?: boolean;
}) {
  const animated = useAnimatedNumber(value);
  return (
    <div className="kpi-cell">
      <span className="kpi-label">{label}</span>
      {/* break-words дублирует overflow-wrap из .kpi-value, но задаёт защиту
          явно: кастомные классы объявлены вне слоёв Tailwind. */}
      <span className="kpi-value mono break-words" style={tone ? { color: tone } : undefined}>
        {percent ? `${Math.round(animated)}%` : formatNumber(animated, currency)}
      </span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  );
}

function Delta({ current, previous, invert = false }: { current: number; previous: number; invert?: boolean }) {
  if (previous <= 0) return <span style={{ color: "var(--muted)" }}>нет базы</span>;
  const d = percentOf(current - previous, previous);
  const up = d >= 0;
  const good = invert ? !up : up;
  return (
    <span className="inline-flex items-center gap-1" style={{ color: good ? "var(--ok)" : "var(--pink)" }}>
      {up ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
      {formatPct(d, 0)} к прошлому мес.
    </span>
  );
}

const dueLabel = (iso: string): string => {
  const d = daysUntil(iso);
  if (d < 0) return `просрочен ${Math.abs(d)} ${plural(Math.abs(d), "день", "дня", "дней")}`;
  if (d === 0) return "сегодня";
  if (d === 1) return "завтра";
  return `через ${d} ${plural(d, "день", "дня", "дней")}`;
};

export function Dashboard() {
  const { data, go, openTxModal, loadDemo } = useApp();
  const { transactions: txs, currency } = data;

  const all = totals(txs);
  const cur = monthTotals(txs, 0);
  const prev = monthTotals(txs, -1);
  const flow = cashflowSeries(txs, 6);
  const breakdown = categoryBreakdown(txs, 0);
  const upcoming = upcomingPayments(data.subscriptions, data.fixedPayments, data.pendingPayments, 30);
  const portfolio = portfolioStats(data.investments);
  const budgetStats = computeBudgetStats(data.budgets, txs).sort((a, b) => b.pct - a.pct);
  const recent = [...txs]
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);

  const investedValue = portfolio.value;
  const goalsSaved = data.goals.reduce((s, g) => s + g.savedAmount, 0);
  const available = all.balance - investedValue - goalsSaved;
  const savingsRate = cur.income > 0 ? percentOf(cur.income - cur.expense, cur.income) : 0;

  // 🔥 Оставляем только топ-6 категорий
  const donutSlices = breakdown.slice(0, 6).map((b) => ({
    id: b.id,
    label: categoryById(b.id).label,
    value: b.value,
    color: categoryById(b.id).color,
  }));

  if (txs.length === 0) {
    return (
      <div>
        <PageHeader kicker="Панель управления" title="Обзор" />
        <div className="card cut p-6 rise-in">
          <EmptyState
            icon={Sparkles}
            title="Данных пока нет"
            text="Добавьте первую транзакцию или загрузите демонстрационный набор, чтобы увидеть дашборд в действии."
            action={
              <div className="flex flex-wrap gap-3 justify-center">
                <button className="btn btn-primary" onClick={() => openTxModal()}><Plus size={15} /> Добавить транзакцию</button>
                <button className="btn btn-ghost" onClick={loadDemo}>Загрузить демо-данные</button>
              </div>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        kicker="Панель управления"
        title="Обзор"
        actions={
          <>
            <span className="chip-date mono">{currentMonthLabel()}</span>
            <button className="btn btn-primary" onClick={() => openTxModal()}><Plus size={15} /> Транзакция</button>
          </>
        }
      />

      {/* KPI-полоса */}
      <section className="card cut kpi-strip rise-in" aria-label="Ключевые метрики">
        <Kpi label="Общий баланс" value={all.balance} currency={currency} tone="var(--accent)" />
        <Kpi label="Доходы / мес" value={cur.income} currency={currency} tone="var(--ok)" sub={<Delta current={cur.income} previous={prev.income} />} />
        <Kpi label="Расходы / мес" value={cur.expense} currency={currency} tone="var(--pink)" sub={<Delta current={cur.expense} previous={prev.expense} invert />} />
        <Kpi
          label="Норма сбережений"
          value={savingsRate}
          currency={currency}
          percent
          tone={savingsRate >= 20 ? "var(--ok)" : savingsRate >= 0 ? "var(--warn)" : "var(--pink)"}
          sub={<span style={{ color: "var(--muted)" }}>от доходов месяца</span>}
        />
        <Kpi label="Доступные средства" value={available} currency={currency} sub={<span style={{ color: "var(--muted)" }}>без инвестиций и целей</span>} />
      </section>

      {/* Ряд 1: поток + инвестиции */}
      <div className="grid lg:grid-cols-3 gap-5">
        <section className="card cut p-5 lg:col-span-2 rise-in" style={{ animationDelay: "60ms" }}>
          <header className="card-head">
            <h2 className="card-title">Денежный поток</h2>
            <span className="card-sub">6 месяцев</span>
          </header>
          <CashflowChart data={flow} currency={currency} />
        </section>

        <section className="card cut p-5 flex flex-col rise-in" style={{ animationDelay: "120ms" }} aria-label="Инвестиционный виджет">
          <header className="card-head">
            <h2 className="card-title">Инвестиции</h2>
            <button className="card-link" onClick={() => go("investments")}>портфель <ChevronRight size={13} /></button>
          </header>
          {data.investments.length === 0 ? (
            <p className="text-sm mt-3" style={{ color: "var(--muted)" }}>Активов пока нет — добавьте первый тикер.</p>
          ) : (
            <>
              <PortfolioValue value={portfolio.value} currency={currency} />
              <div
                className="mt-1.5 inline-flex items-center gap-1.5 text-sm font-semibold w-fit px-2 py-1"
                style={{
                  color: portfolio.profit >= 0 ? "var(--ok)" : "var(--pink)",
                  background: `color-mix(in srgb, ${portfolio.profit >= 0 ? "var(--ok)" : "var(--pink)"} 10%, transparent)`,
                }}
              >
                {portfolio.profit >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                {formatSigned(portfolio.profit, currency)} · {formatPct(portfolio.pct)}
              </div>
              {/* Суммы содержат неразрывный пробел и не переносятся: даём им
                  перенос (break-words), а подписи фиксируем shrink-0. */}
              <dl className="mt-4 space-y-2 text-sm flex-1">
                <div className="flex justify-between gap-3"><dt className="shrink-0" style={{ color: "var(--muted)" }}>Вложено</dt><dd className="mono text-right min-w-0 break-words" style={{ color: "var(--text)" }}>{formatNumber(portfolio.invested, currency)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="shrink-0" style={{ color: "var(--muted)" }}>Активов</dt><dd className="mono text-right min-w-0 break-words" style={{ color: "var(--text)" }}>{data.investments.length}</dd></div>
                <div className="flex justify-between gap-3"><dt className="shrink-0" style={{ color: "var(--muted)" }}>Доля от баланса</dt><dd className="mono text-right min-w-0 break-words" style={{ color: "var(--text)" }}>{all.balance > 0 ? formatPct(percentOf(portfolio.value, all.balance), 0) : "—"}</dd></div>
              </dl>
            </>
          )}
        </section>
      </div>

      {/* Ряд 2: донат + последние + ближайшие */}
      <div className="grid lg:grid-cols-3 gap-5">
        <section className="card cut p-5 rise-in" style={{ animationDelay: "160ms" }}>
          <header className="card-head">
            <h2 className="card-title">Расходы по категориям</h2>
            <span className="card-sub">{currentMonthLabel()}</span>
          </header>
          {donutSlices.length === 0 ? (
            <p className="text-sm mt-3" style={{ color: "var(--muted)" }}>В этом месяце расходов ещё не было.</p>
          ) : (
            <DonutChart slices={donutSlices} currency={currency} />
          )}
        </section>

        <section className="card cut p-5 rise-in" style={{ animationDelay: "220ms" }}>
          <header className="card-head">
            <h2 className="card-title">Последние операции</h2>
            <button className="card-link" onClick={() => go("transactions")}>все <ChevronRight size={13} /></button>
          </header>
          <ul className="divide-y" style={{ borderColor: "var(--line)" }}>
            {recent.map((t) => (
              <li key={t.id}>
                <button className="tx-row" onClick={() => go("transactions")}>
                  <CategoryHex id={t.category} size={34} />
                  <span className="flex-1 min-w-0 text-left">
                    <span className="block text-sm truncate" style={{ color: "var(--text)" }}>
                      {t.description ?? categoryById(t.category).label}
                    </span>
                    <span className="block text-[11px] mt-0.5" style={{ color: "var(--muted)" }}>
                      {formatDateShort(t.date)} · {SOURCE_LABELS[t.source]}
                    </span>
                  </span>
                  <span className="mono text-sm font-semibold shrink-0 text-right" style={{ color: t.type === "income" ? "var(--ok)" : "var(--pink)" }}>
                    {t.type === "income" ? "+" : "−"}{formatNumber(t.amount, currency)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="card cut p-5 rise-in" style={{ animationDelay: "280ms" }}>
          <header className="card-head">
            <h2 className="card-title">Ближайшие платежи</h2>
            <button className="card-link" onClick={() => go("confirm")}>
              подтвердить{data.pendingPayments.length > 0 ? ` (${data.pendingPayments.length})` : ""} <ChevronRight size={13} />
            </button>
          </header>
          {upcoming.length === 0 ? (
            <p className="text-sm mt-3" style={{ color: "var(--muted)" }}>В ближайшие 30 дней платежей нет.</p>
          ) : (
            <ul className="space-y-2.5 mt-1">
              {upcoming.slice(0, 6).map((u) => {
                const overdue = daysUntil(u.due) < 0;
                return (
                  <li key={u.key} className="flex items-center gap-3">
                    <span className="pay-dot" style={{ background: overdue ? "var(--danger)" : u.pending ? "var(--warn)" : "var(--accent)" }} aria-hidden />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm truncate" style={{ color: "var(--text)" }}>{u.name}</span>
                      <span className="block text-[11px]" style={{ color: overdue ? "var(--danger)" : "var(--muted)" }}>
                        {formatDateShort(u.due)} · {dueLabel(u.due)}
                      </span>
                    </span>
                    <span className="mono text-sm font-semibold shrink-0 text-right" style={{ color: "var(--text)" }}>{formatNumber(u.amount, currency)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {/* Ряд 3: бюджеты + цели */}
      <div className="grid lg:grid-cols-2 gap-5">
        <section className="card cut p-5 rise-in" style={{ animationDelay: "320ms" }}>
          <header className="card-head">
            <h2 className="card-title">Бюджет месяца</h2>
            <button className="card-link" onClick={() => go("budget")}>управлять <ChevronRight size={13} /></button>
          </header>
          {budgetStats.length === 0 ? (
            <p className="text-sm mt-3" style={{ color: "var(--muted)" }}>Лимиты не настроены.</p>
          ) : (
            <ul className="space-y-4 mt-1">
              {budgetStats.slice(0, 4).map((b) => {
                const cat = categoryById(b.budget.category);
                const color = b.status === "over" ? "var(--danger)" : b.status === "warn" ? "var(--warn)" : "var(--ok)";
                return (
                  <li key={b.budget.id}>
                    <div className="flex items-center justify-between gap-3 text-sm mb-1.5">
                      <span className="flex items-center gap-2 min-w-0" style={{ color: "var(--text)" }}>
                        <i className="dot" style={{ background: cat.color }} /> <span className="truncate">{cat.label}</span>
                      </span>
                      <span className="mono text-xs shrink-0 text-right break-words" style={{ color: "var(--muted)" }}>
                        {formatNumber(b.spent, currency, true)} / {formatNumber(b.budget.limit, currency, true)}
                      </span>
                    </div>
                    <ProgressBar pct={b.pct} color={color} height={6} />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="card cut p-5 rise-in" style={{ animationDelay: "380ms" }}>
          <header className="card-head">
            <h2 className="card-title">Финансовые цели</h2>
            <button className="card-link" onClick={() => go("goals")}>все <ChevronRight size={13} /></button>
          </header>
          {data.goals.length === 0 ? (
            <p className="text-sm mt-3" style={{ color: "var(--muted)" }}>Целей пока нет — поставьте первую.</p>
          ) : (
            <ul className="space-y-4 mt-1">
              {data.goals.slice(0, 3).map((g) => {
                const pct = percentOf(g.savedAmount, g.targetAmount);
                const done = isReached(g);
                return (
                  <li key={g.id}>
                    {/* Название цели обрезаем, а правую часть фиксируем: без
                        min-w-0/truncate длинная цель выдавливала процент и дату
                        за край карточки. */}
                    <div className="flex items-center justify-between gap-3 text-sm mb-1.5">
                      <span className="min-w-0 truncate" style={{ color: "var(--text)" }}>{g.name}</span>
                      <span className="mono text-xs shrink-0" style={{ color: done ? "var(--ok)" : "var(--muted)" }}>
                        {Math.round(pct)}%{done ? " · достигнута" : ""}
                      </span>
                    </div>
                    <ProgressBar pct={pct} color={done ? "var(--ok)" : "var(--accent)"} height={6} />
                    <div className="flex justify-between gap-3 text-[11px] mt-1" style={{ color: "var(--muted)" }}>
                      <span className="mono min-w-0 break-words">{formatNumber(g.savedAmount, currency, true)} из {formatNumber(g.targetAmount, currency, true)}</span>
                      <span className="shrink-0 text-right">до {formatDateShort(g.deadline)} {parseISO(g.deadline).getFullYear()}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function PortfolioValue({ value, currency }: { value: number; currency: Currency }) {
  const animated = useAnimatedNumber(value);
  // break-words: Orbitron 26px на крупной сумме не помещался в узкую колонку.
  return (
    <span className="font-display font-bold text-[26px] leading-none mt-3 block break-words" style={{ color: "var(--text)" }}>
      {formatNumber(animated, currency)}
    </span>
  );
}