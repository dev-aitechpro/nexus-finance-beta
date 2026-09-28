import {
  AlertTriangle, Flag, Percent, PiggyBank, Pencil, Plus, Target, Trash2, TrendingUp, Wallet,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { useApp } from "../hooks/AppProvider";
import {
  CategoryHex, ConfirmDialog, EmptyState, Field, Modal, PageHeader, ProgressBar,
} from "../components/ui";
import { computeBudgetStats, goalMonthlyNeed, isReached } from "../lib/engine";
import { CATEGORIES, categoryById } from "../lib/constants";
import { CategoryPicker } from "../components/CategoryPicker";
import type { Budget, Goal } from "../lib/types";
import {
  addMonths, daysUntil, formatDate, formatNumber, parseAmount, percentOf,
  plural, toISO, uid,
} from "../lib/utils";

/** Имена целей приходят из данных и не имеют ограничения длины. Заголовок и
    текст модалки рендерит ui.tsx без обрезки и без переносов, поэтому длинное
    имя здесь режем до разумной длины. */
const shortName = (s: string, max = 40): string =>
  s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;

/* ─────────────────────────── Модалка лимита ─────────────────────────── */

function BudgetModal({
  open, onClose, editing, usedCategories,
}: {
  open: boolean; onClose: () => void; editing: Budget | null; usedCategories: string[];
}) {
  const { setBudget } = useApp();
  const [category, setCategory] = useState("");
  const [limit, setLimit] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [seeded, setSeeded] = useState<string | null>(null);

  const available = CATEGORIES.filter(
    (c) => c.type === "expense" && (editing?.category === c.id || !usedCategories.includes(c.id)),
  );

  const key = editing?.id ?? "new";
  if (open && seeded !== key) {
    setSeeded(key);
    setCategory(editing?.category ?? available[0]?.id ?? "");
    setLimit(editing ? String(editing.limit) : "");
    setErrors({});
  }
  if (!open && seeded !== null) setSeeded(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = parseAmount(limit);
    const errs: Record<string, string> = {};
    if (!category) errs.category = "Выберите категорию";
    if (n <= 0) errs.limit = "Лимит должен быть больше нуля";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBudget(category, n);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? "Изменить лимит" : "Новый лимит бюджета"}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Категория расходов" error={errors.category}>
          {editing !== null ? (
            // при правке лимита категория уже зафиксирована — показываем иконкой,
            // но не даём выбрать другую (иначе интерфейс соврал бы)
            <span className="flex items-center gap-2.5">
              <CategoryHex id={category} size={32} />
              <span className="text-sm truncate" style={{ color: "var(--text)" }}>
                {categoryById(category).label}
              </span>
            </span>
          ) : (
            <CategoryPicker value={category} onChange={setCategory} type="expense" error={errors.category} />
          )}
        </Field>
        <Field label="Месячный лимит" error={errors.limit}>
          <input className="input mono" inputMode="decimal" placeholder="0" value={limit} autoFocus
            onChange={(e) => setLimit(e.target.value.replace(/[^\d\s.,]/g, ""))} />
        </Field>
        <div className="flex justify-end gap-3 pt-1">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn btn-primary">Сохранить</button>
        </div>
      </form>
    </Modal>
  );
}

/* ─────────────────────────── Вкладка «Бюджет» ─────────────────────────── */

export function BudgetView() {
  const { data, deleteBudget } = useApp();
  const currency = data.currency;
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<Budget | null>(null);
  const [toDelete, setToDelete] = useState<Budget | null>(null);

  const stats = useMemo(() => computeBudgetStats(data.budgets, data.transactions), [data.budgets, data.transactions]);
  const totalLimit = stats.reduce((s, b) => s + b.budget.limit, 0);
  const totalSpent = stats.reduce((s, b) => s + b.spent, 0);

  return (
    <div>
      <PageHeader
        kicker="Контроль расходов"
        title="Бюджет"
        actions={<button className="btn btn-primary" onClick={() => { setEditing(null); setModal(true); }}><Plus size={15} /> Установить лимит</button>}
      />

      {stats.length > 0 && (
        <section className="card cut kpi-strip rise-in mb-5" aria-label="Сводка бюджета">
          <div className="kpi-cell">
            <span className="kpi-label">Лимиты месяца</span>
            <span className="kpi-value mono break-words">{formatNumber(totalLimit, currency)}</span>
          </div>
          <div className="kpi-cell">
            <span className="kpi-label">Потрачено</span>
            <span className="kpi-value mono break-words" style={{ color: totalSpent > totalLimit ? "var(--danger)" : "var(--pink)" }}>{formatNumber(totalSpent, currency)}</span>
          </div>
          <div className="kpi-cell">
            <span className="kpi-label">Остаток</span>
            <span className="kpi-value mono break-words" style={{ color: totalLimit - totalSpent < 0 ? "var(--danger)" : "var(--ok)" }}>{formatNumber(totalLimit - totalSpent, currency)}</span>
          </div>
          <div className="kpi-cell">
            <span className="kpi-label">Использование</span>
            <span className="kpi-value mono break-words" style={{ color: percentOf(totalSpent, totalLimit) >= 100 ? "var(--danger)" : "var(--text)" }}>
              {Math.round(percentOf(totalSpent, totalLimit))}%
            </span>
          </div>
        </section>
      )}

      {stats.length === 0 ? (
        <section className="card cut p-6 rise-in">
          <EmptyState
            icon={Wallet}
            title="Лимиты не настроены"
            text="Задайте месячный лимит для категорий расходов — NEXUS будет следить за использованием и предупреждать о перерасходе."
            action={<button className="btn btn-primary" onClick={() => { setEditing(null); setModal(true); }}><Plus size={15} /> Установить первый лимит</button>}
          />
        </section>
      ) : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-5">
          {stats.map((b, i) => {
            const cat = categoryById(b.budget.category);
            const color = b.status === "over" ? "var(--danger)" : b.status === "warn" ? "var(--warn)" : "var(--ok)";
            const forecastOver = b.forecast > b.budget.limit;
            const prevDelta = b.prevSpent > 0 ? percentOf(b.spent - b.prevSpent, b.prevSpent) : null;
            return (
              <article key={b.budget.id} className="card cut p-5 rise-in" style={{ animationDelay: `${i * 60}ms` }}>
                <header className="flex items-center gap-3">
                  <CategoryHex id={cat.id} size={40} />
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold truncate" style={{ color: "var(--text)" }}>{cat.label}</h3>
                    {/* Суммы с неразрывным пробелом не переносятся — при узкой
                        карточке строка «потрачено из лимита» лезла за край. */}
                    <span className="block text-[11px] mono break-words" style={{ color: "var(--muted)" }}>
                      {formatNumber(b.spent, currency)} из {formatNumber(b.budget.limit, currency)}
                    </span>
                  </div>
                  <span className="flex gap-1">
                    <button className="btn-icon" title="Изменить лимит" aria-label={`Изменить лимит ${cat.label}`} onClick={() => { setEditing(b.budget); setModal(true); }}><Pencil size={13} /></button>
                    <button className="btn-icon btn-icon-danger" title="Удалить" aria-label={`Удалить бюджет ${cat.label}`} onClick={() => setToDelete(b.budget)}><Trash2 size={13} /></button>
                  </span>
                </header>
                <div className="flex items-center gap-3 mt-4">
                  <ProgressBar pct={b.pct} color={color} height={9} />
                  <span className="mono text-xs font-bold shrink-0" style={{ color }}>{Math.round(b.pct)}%</span>
                </div>
                <div className="mt-3 space-y-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
                  <p className="flex items-center gap-1.5">
                    <TrendingUp size={12} className="shrink-0" />
                    Прогноз к концу месяца: <b className="mono" style={{ color: forecastOver ? "var(--danger)" : "var(--text)" }}>{formatNumber(Math.round(b.forecast), currency)}</b>
                    {forecastOver && <span style={{ color: "var(--danger)" }}>(перерасход {formatNumber(Math.round(b.forecast - b.budget.limit), currency)})</span>}
                  </p>
                  {prevDelta !== null && (
                    <p className="flex items-center gap-1.5">
                      <Percent size={12} className="shrink-0" />
                      К прошлому месяцу: <b className="mono" style={{ color: prevDelta > 0 ? "var(--pink)" : "var(--ok)" }}>{prevDelta > 0 ? "+" : ""}{Math.round(prevDelta)}%</b>
                    </p>
                  )}
                  {b.status === "over" && (
                    <p className="flex items-center gap-1.5" style={{ color: "var(--danger)" }}>
                      <AlertTriangle size={12} className="shrink-0" /> Лимит превышен
                    </p>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <BudgetModal open={modal} onClose={() => setModal(false)} editing={editing} usedCategories={data.budgets.map((b) => b.category)} />
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        title="Удалить бюджет?"
        text={`Лимит для категории «${toDelete ? categoryById(toDelete.category).label : ""}» будет удалён. Транзакции останутся без изменений.`}
        onConfirm={() => toDelete && deleteBudget(toDelete.id)}
      />
    </div>
  );
}

/* ─────────────────────────── Модалки целей ─────────────────────────── */

function GoalModal({ open, onClose, editing }: { open: boolean; onClose: () => void; editing: Goal | null }) {
  const { saveGoal } = useApp();
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [saved, setSaved] = useState("0");
  const [deadline, setDeadline] = useState(toISO(addMonths(new Date(), 6)));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [seeded, setSeeded] = useState<string | null>(null);

  const key = editing?.id ?? "new";
  if (open && seeded !== key) {
    setSeeded(key);
    setName(editing?.name ?? "");
    setTarget(editing ? String(editing.targetAmount) : "");
    setSaved(editing ? String(editing.savedAmount) : "0");
    setDeadline(editing?.deadline ?? toISO(addMonths(new Date(), 6)));
    setErrors({});
  }
  if (!open && seeded !== null) setSeeded(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = parseAmount(target);
    const s = parseAmount(saved);
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = "Укажите название цели";
    if (t <= 0) errs.target = "Целевая сумма должна быть больше нуля";
    if (s < 0 || s > t) errs.saved = "От 0 до целевой суммы";
    if (!deadline) errs.deadline = "Укажите срок";
    else if (!editing && deadline < toISO(new Date())) errs.deadline = "Срок не может быть в прошлом";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    saveGoal({
      id: editing?.id ?? uid(),
      name: name.trim(),
      targetAmount: t,
      savedAmount: editing ? editing.savedAmount : s,
      deadline,
      createdAt: editing?.createdAt ?? new Date().toISOString(),
    });
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? "Редактировать цель" : "Новая финансовая цель"}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Название цели" error={errors.name}>
          {/* maxLength: имя попадает в заголовки карточек и в текст модалки без
              обрезки — ограничиваем ввод, чтобы длинная цель не ломала вёрстку. */}
          <input className="input" placeholder="Например: Финансовая подушка" value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Целевая сумма" error={errors.target}>
            <input className="input mono" inputMode="decimal" placeholder="0" value={target}
              onChange={(e) => setTarget(e.target.value.replace(/[^\d\s.,]/g, ""))} />
          </Field>
          <Field label={editing ? "Накоплено (не меняется здесь)" : "Уже накоплено"} error={errors.saved}>
            <input className="input mono" inputMode="decimal" value={saved} disabled={editing !== null}
              onChange={(e) => setSaved(e.target.value.replace(/[^\d\s.,]/g, ""))} />
          </Field>
        </div>
        <Field label="Срок достижения" error={errors.deadline}>
          <input className="input" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-3 pt-1">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn btn-primary">{editing ? "Сохранить" : "Создать"}</button>
        </div>
      </form>
    </Modal>
  );
}

function FundModal({ goal, open, onClose }: { goal: Goal | null; open: boolean; onClose: () => void }) {
  const { data, fundGoal } = useApp();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [seeded, setSeeded] = useState<string | null>(null);

  if (open && seeded !== goal?.id) {
    setSeeded(goal?.id ?? null);
    setAmount("");
    setError("");
  }
  if (!open && seeded !== null) setSeeded(null);

  if (!goal) return null;
  const remaining = Math.max(0, goal.targetAmount - goal.savedAmount);
  const n = parseAmount(amount);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (n <= 0) { setError("Введите сумму больше нуля"); return; }
    fundGoal(goal.id, n);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Пополнение цели">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {/* Имя цели — в теле модалки, а не в заголовке: заголовок в ui.tsx без
            обрезки, и длинное имя ломало бы шапку окна. */}
        <p className="text-sm font-semibold truncate" style={{ color: "var(--text)" }}>{goal.name}</p>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Осталось накопить <b className="mono" style={{ color: "var(--text)" }}>{formatNumber(remaining, data.currency)}</b>. Пополнение создаст расход «Цели и накопления» и спишется с баланса.
        </p>
        <Field label="Сумма пополнения" error={error}>
          <input className="input mono" inputMode="decimal" placeholder="0" value={amount} autoFocus
            onChange={(e) => { setAmount(e.target.value.replace(/[^\d\s.,]/g, "")); setError(""); }} />
        </Field>
        <div className="flex flex-wrap gap-2">
          {[1000, 5000, 10000].map((v) => (
            <button type="button" key={v} className="chip" onClick={() => setAmount(String(v))}>+{v.toLocaleString("ru-RU")}</button>
          ))}
          <button type="button" className="chip" onClick={() => setAmount(String(remaining))}>Весь остаток</button>
        </div>
        <div className="flex justify-end gap-3 pt-1">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn btn-primary"><PiggyBank size={15} /> Пополнить</button>
        </div>
      </form>
    </Modal>
  );
}

/* ─────────────────────────── Вкладка «Цели» ─────────────────────────── */

export function GoalsView() {
  const { data, deleteGoal } = useApp();
  const currency = data.currency;
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [funding, setFunding] = useState<Goal | null>(null);
  const [toDelete, setToDelete] = useState<Goal | null>(null);

  const goals = [...data.goals].sort((a, b) => percentOf(b.savedAmount, b.targetAmount) - percentOf(a.savedAmount, a.targetAmount));

  return (
    <div>
      <PageHeader
        kicker="Накопления"
        title="Финансовые цели"
        actions={<button className="btn btn-primary" onClick={() => { setEditing(null); setModal(true); }}><Plus size={15} /> Новая цель</button>}
      />

      {goals.length === 0 ? (
        <section className="card cut p-6 rise-in">
          <EmptyState
            icon={Target}
            title="Целей пока нет"
            text="Подушка безопасности, новый ноутбук или путешествие — поставьте цель, и пополнения будут автоматически фиксироваться в журнале."
            action={<button className="btn btn-primary" onClick={() => { setEditing(null); setModal(true); }}><Plus size={15} /> Поставить цель</button>}
          />
        </section>
      ) : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-5">
          {goals.map((g, i) => {
            const pct = percentOf(g.savedAmount, g.targetAmount);
            const done = isReached(g);
            const dl = daysUntil(g.deadline);
            const need = goalMonthlyNeed(g);
            return (
              <article
                key={g.id}
                className={`card cut p-5 flex flex-col rise-in ${done ? "goal-done" : ""}`}
                style={{ animationDelay: `${i * 70}ms` }}
              >
                <header className="flex items-start gap-3">
                  <span
                    className="hex flex items-center justify-center shrink-0"
                    style={{
                      width: 40, height: 40,
                      // Контур рисует .hex (inset-тень по clip-path), цвет задаём здесь
                      color: done ? "var(--ok)" : "var(--accent)",
                      background: `linear-gradient(160deg, ${done ? "var(--ok)" : "var(--accent)"}22, transparent)`,
                    }}
                  >
                    <Flag size={17} strokeWidth={1.8} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold truncate" style={{ color: "var(--text)" }}>{g.name}</h3>
                    <span className="text-[11px]" style={{ color: "var(--muted)" }}>
                      {dl >= 0
                        ? `до ${formatDate(g.deadline)} · ${dl} ${plural(dl, "день", "дня", "дней")}`
                        : `срок истёк ${formatDate(g.deadline)}`}
                    </span>
                  </div>
                  <span className="flex gap-1">
                    <button className="btn-icon" title="Редактировать" aria-label={`Редактировать цель ${g.name}`} onClick={() => { setEditing(g); setModal(true); }}><Pencil size={13} /></button>
                    <button className="btn-icon btn-icon-danger" title="Удалить" aria-label={`Удалить цель ${g.name}`} onClick={() => setToDelete(g)}><Trash2 size={13} /></button>
                  </span>
                </header>

                <div className="flex items-end justify-between gap-3 mt-4">
                  <span className="font-display font-bold text-2xl leading-none shrink-0" style={{ color: done ? "var(--ok)" : "var(--text)" }}>
                    {Math.min(999, Math.round(pct))}%
                  </span>
                  {done && (
                    <span className="badge" style={{ color: "var(--ok)", borderColor: "color-mix(in srgb, var(--ok) 45%, transparent)", background: "color-mix(in srgb, var(--ok) 10%, transparent)" }}>
                      достигнута
                    </span>
                  )}
                </div>
                <div className="mt-3">
                  <ProgressBar pct={pct} color={done ? "var(--ok)" : "var(--accent)"} height={10} />
                </div>
                <div className="flex justify-between gap-3 text-[11px] mono mt-1.5" style={{ color: "var(--muted)" }}>
                  <span className="min-w-0 break-words">{formatNumber(g.savedAmount, currency)}</span>
                  <span className="min-w-0 break-words text-right">{formatNumber(g.targetAmount, currency)}</span>
                </div>

                {!done && (
                  <p className="text-[11px] mt-3" style={{ color: "var(--muted)" }}>
                    Откладывайте ≈ <b className="mono" style={{ color: "var(--text)" }}>{formatNumber(Math.ceil(need), currency)}</b> в месяц, чтобы успеть к сроку
                  </p>
                )}

                <div className="mt-auto pt-4">
                  <button className="btn btn-primary w-full" onClick={() => setFunding(g)} disabled={done}>
                    <PiggyBank size={15} /> {done ? "Цель достигнута" : "Пополнить"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <GoalModal open={modal} onClose={() => setModal(false)} editing={editing} />
      <FundModal goal={funding} open={funding !== null} onClose={() => setFunding(null)} />
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        title="Удалить цель?"
        text={`«${shortName(toDelete?.name ?? "")}» будет удалена. Связанные транзакции пополнения останутся в журнале.`}
        onConfirm={() => toDelete && deleteGoal(toDelete.id)}
      />
    </div>
  );
}
