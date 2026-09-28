// src/views/Payments.tsx
import { CalendarClock, Check, CheckCircle2, Pencil, Plus, Repeat, SkipForward, Trash2, Zap } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { useApp } from "../hooks/AppProvider";
import {
  CategoryHex, ConfirmDialog, EmptyState, Field, Modal, PageHeader, Segmented, Toggle,
} from "../components/ui";
import { categoryById } from "../lib/constants";
import { CategoryPicker } from "../components/CategoryPicker";
import { isActionablePending } from "../lib/engine";
import type { FixedPayment, PendingPayment, Period, Subscription } from "../lib/types";
import {
  addMonths, clampedDate, daysUntil, formatDate, formatDateShort, formatNumber,
  parseAmount, plural, startOfDay, toISO, todayISO, uid,
} from "../lib/utils";

/* ─────────────────────────── Хелперы ─────────────────────────── */

function nextDueLabel(day: number, period: Period, createdAt: string): string {
  const now = startOfDay(new Date());
  let due: Date;
  if (period === "yearly") {
    const m = new Date(createdAt.slice(0, 10)).getMonth();
    due = clampedDate(now.getFullYear(), m, day);
    if (due < now) due = clampedDate(now.getFullYear() + 1, m, day);
  } else {
    due = clampedDate(now.getFullYear(), now.getMonth(), day);
    if (due < now) {
      const n = addMonths(now, 1);
      due = clampedDate(n.getFullYear(), n.getMonth(), day);
    }
  }
  return formatDate(toISO(due));
}

/* ─────────────────────────── Модалка подписки ─────────────────────────── */

function SubscriptionModal({
  open, onClose, editing,
}: {
  open: boolean; onClose: () => void; editing: Subscription | null;
}) {
  const { saveSubscription } = useApp();
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [period, setPeriod] = useState<Period>("monthly");
  const [billingDay, setBillingDay] = useState("1");
  const [reminderDays, setReminderDays] = useState("2");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [seeded, setSeeded] = useState<string | null>(null);

  const key = editing?.id ?? "new";
  if (open && seeded !== key) {
    setSeeded(key);
    setName(editing?.name ?? "");
    setAmount(editing ? String(editing.amount) : "");
    setPeriod(editing?.period ?? "monthly");
    setBillingDay(String(editing?.billingDay ?? 1));
    setReminderDays(String(editing?.reminderDays ?? 2));
    setErrors({});
  }
  if (!open && seeded !== null) setSeeded(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = parseAmount(amount);
    const day = parseInt(billingDay, 10);
    const rem = parseInt(reminderDays, 10);
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = "Укажите название сервиса";
    if (n <= 0) errs.amount = "Сумма должна быть больше нуля";
    if (!Number.isFinite(day) || day < 1 || day > 31) errs.billingDay = "День от 1 до 31";
    if (!Number.isFinite(rem) || rem < 0 || rem > 60) errs.reminderDays = "От 0 до 60 дней";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    saveSubscription({
      id: editing?.id ?? uid(),
      name: name.trim(),
      amount: n,
      period,
      billingDay: day,
      reminderDays: rem,
      lastConfirmed: editing?.lastConfirmed ?? null,
      createdAt: editing?.createdAt ?? new Date().toISOString(),
    });
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? "Редактировать подписку" : "Новая подписка"}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Название сервиса" error={errors.name}>
          <input className="input" placeholder="Например: Spotify" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Сумма" error={errors.amount}>
            <input className="input mono" inputMode="decimal" placeholder="0" value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d\s.,]/g, ""))} />
          </Field>
          <Field label="Период">
            <Segmented<Period>
              options={[{ value: "monthly", label: "Месяц" }, { value: "yearly", label: "Год" }]}
              value={period}
              onChange={setPeriod}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="День списания" error={errors.billingDay} hint="1–31, длинные месяцы урезаются автоматически">
            <input className="input mono" inputMode="numeric" value={billingDay}
              onChange={(e) => setBillingDay(e.target.value.replace(/\D/g, "").slice(0, 2))} />
          </Field>
          <Field label="Напоминание, дней" error={errors.reminderDays}>
            <input className="input mono" inputMode="numeric" value={reminderDays}
              onChange={(e) => setReminderDays(e.target.value.replace(/\D/g, "").slice(0, 2))} />
          </Field>
        </div>
        <div className="flex justify-end gap-3 pt-1">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn btn-primary">{editing ? "Сохранить" : "Добавить"}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ─────────────────────────── Модалка фиксированного платежа ─────────────────────────── */

function FixedModal({
  open, onClose, editing,
}: {
  open: boolean; onClose: () => void; editing: FixedPayment | null;
}) {
  const { saveFixedPayment } = useApp();
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("housing");
  const [payDay, setPayDay] = useState("5");
  const [autoPay, setAutoPay] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [seeded, setSeeded] = useState<string | null>(null);

  const key = editing?.id ?? "new";
  if (open && seeded !== key) {
    setSeeded(key);
    setName(editing?.name ?? "");
    setAmount(editing ? String(editing.amount) : "");
    setCategory(editing?.category ?? "housing");
    setPayDay(String(editing?.payDay ?? 5));
    setAutoPay(editing?.autoPay ?? false);
    setErrors({});
  }
  if (!open && seeded !== null) setSeeded(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = parseAmount(amount);
    const day = parseInt(payDay, 10);
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = "Укажите название платежа";
    if (n <= 0) errs.amount = "Сумма должна быть больше нуля";
    if (!Number.isFinite(day) || day < 1 || day > 31) errs.payDay = "День от 1 до 31";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    saveFixedPayment({
      id: editing?.id ?? uid(),
      name: name.trim(),
      amount: n,
      category,
      payDay: day,
      autoPay,
      lastConfirmed: editing?.lastConfirmed ?? null,
      createdAt: editing?.createdAt ?? new Date().toISOString(),
    });
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? "Редактировать платёж" : "Новый фиксированный платёж"}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Название платежа" error={errors.name}>
          <input className="input" placeholder="Например: Аренда квартиры" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Сумма" error={errors.amount}>
            <input className="input mono" inputMode="decimal" placeholder="0" value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d\s.,]/g, ""))} />
          </Field>
          <Field label="Категория">
            <CategoryPicker value={category} onChange={setCategory} type="expense" compact />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4 items-end">
          <Field label="День оплаты" error={errors.payDay}>
            <input className="input mono" inputMode="numeric" value={payDay}
              onChange={(e) => setPayDay(e.target.value.replace(/\D/g, "").slice(0, 2))} />
          </Field>
          <div className="flex items-center justify-between gap-3 pb-2.5">
            <span className="text-sm" style={{ color: "var(--text)" }}>Автоплатёж</span>
            <Toggle checked={autoPay} onChange={setAutoPay} label="Автоплатёж" />
          </div>
        </div>
        <div className="flex justify-end gap-3 pt-1">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn btn-primary">{editing ? "Сохранить" : "Добавить"}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ─────────────────────────── Вкладка «Платежи» ─────────────────────────── */

export function Payments() {
  const { data, deleteRecurringSource } = useApp();
  const currency = data.currency;
  const [subModal, setSubModal] = useState(false);
  const [fixedModal, setFixedModal] = useState(false);
  const [editSub, setEditSub] = useState<Subscription | null>(null);
  const [editFixed, setEditFixed] = useState<FixedPayment | null>(null);
  const [toDelete, setToDelete] = useState<{ kind: "sub" | "fixed"; id: string; name: string } | null>(null);

  const subsMonthly = data.subscriptions.reduce((s, x) => s + (x.period === "monthly" ? x.amount : x.amount / 12), 0);
  const fixedMonthly = data.fixedPayments.reduce((s, x) => s + x.amount, 0);

  return (
    <div>
      <PageHeader
        kicker="Автоматизация"
        title="Регулярные платежи"
        actions={
          <>
            <button className="btn btn-ghost" onClick={() => { setEditFixed(null); setFixedModal(true); }}><Plus size={15} /> Платёж</button>
            <button className="btn btn-primary" onClick={() => { setEditSub(null); setSubModal(true); }}><Plus size={15} /> Подписка</button>
          </>
        }
      />

      <section className="card cut p-5 mb-5 rise-in" aria-label="Подписки">
        <header className="card-head">
          <h2 className="card-title">Подписки</h2>
          <span className="card-sub mono">≈ {formatNumber(subsMonthly, currency)} / мес · {data.subscriptions.length} шт.</span>
        </header>
        {data.subscriptions.length === 0 ? (
          <EmptyState
            icon={Repeat}
            title="Подписок нет"
            text="Добавьте сервисы с регулярной оплатой — приложение само напомнит о списании и создаст платёж на подтверждение."
            action={<button className="btn btn-primary" onClick={() => { setEditSub(null); setSubModal(true); }}><Plus size={15} /> Добавить подписку</button>}
          />
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--line)" }}>
            {data.subscriptions.map((s) => (
              <li key={s.id} className="pay-row">
                {/* Раньше иконка подписки была «вшита» (Repeat + цвет --accent) и не
                    совпадала с категорией «Подписки». Теперь это CategoryHex категории subs —
                    тот же вид, что и в журнале операций. */}
                <CategoryHex id="subs" size={30} />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-semibold truncate" style={{ color: "var(--text)" }}>{s.name}</span>
                  <span className="block text-[11px] mt-0.5" style={{ color: "var(--muted)" }}>
                    {s.period === "monthly" ? "ежемесячно" : "ежегодно"} · день {s.billingDay} · напоминание за {s.reminderDays} {plural(s.reminderDays, "день", "дня", "дней")}
                  </span>
                  <span className="block text-[11px] mt-0.5" style={{ color: "var(--muted)" }}>
                    след. списание: <b style={{ color: "var(--text)" }}>{nextDueLabel(s.billingDay, s.period, s.createdAt)}</b>
                    {s.lastConfirmed && <> · подтверждён {formatDate(s.lastConfirmed)}</>}
                  </span>
                </span>
                <span className="mono text-sm font-semibold mr-1" style={{ color: "var(--text)" }}>{formatNumber(s.amount, currency)}</span>
                <span className="flex gap-1">
                  <button className="btn-icon" title="Редактировать" aria-label={`Редактировать ${s.name}`} onClick={() => { setEditSub(s); setSubModal(true); }}><Pencil size={14} /></button>
                  <button className="btn-icon btn-icon-danger" title="Удалить" aria-label={`Удалить ${s.name}`} onClick={() => setToDelete({ kind: "sub", id: s.id, name: s.name })}><Trash2 size={14} /></button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card cut p-5 rise-in" style={{ animationDelay: "90ms" }} aria-label="Фиксированные платежи">
        <header className="card-head">
          <h2 className="card-title">Фиксированные платежи</h2>
          <span className="card-sub mono">{formatNumber(fixedMonthly, currency)} / мес · {data.fixedPayments.length} шт.</span>
        </header>
        {data.fixedPayments.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title="Платежей нет"
            text="Аренда, коммуналка, интернет — обязательные платежи появятся здесь и будут ждать подтверждения каждый месяц."
            action={<button className="btn btn-primary" onClick={() => { setEditFixed(null); setFixedModal(true); }}><Plus size={15} /> Добавить платёж</button>}
          />
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--line)" }}>
            {data.fixedPayments.map((f) => (
              <li key={f.id} className="pay-row">
                <CategoryHex id={f.category} size={38} />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-semibold truncate" style={{ color: "var(--text)" }}>
                    {f.name}
                    {f.autoPay && (
                      <span className="badge ml-2" style={{ color: "var(--accent)", borderColor: "color-mix(in srgb, var(--accent) 40%, transparent)" }}>
                        <Zap size={11} /> автоплатёж
                      </span>
                    )}
                  </span>
                  <span className="block text-[11px] mt-0.5" style={{ color: "var(--muted)" }}>
                    {categoryById(f.category).label} · день {f.payDay} · след. оплата <b style={{ color: "var(--text)" }}>{nextDueLabel(f.payDay, "monthly", f.createdAt)}</b>
                    {f.lastConfirmed && <> · подтверждён {formatDate(f.lastConfirmed)}</>}
                  </span>
                </span>
                <span className="mono text-sm font-semibold mr-1" style={{ color: "var(--text)" }}>{formatNumber(f.amount, currency)}</span>
                <span className="flex gap-1">
                  <button className="btn-icon" title="Редактировать" aria-label={`Редактировать ${f.name}`} onClick={() => { setEditFixed(f); setFixedModal(true); }}><Pencil size={14} /></button>
                  <button className="btn-icon btn-icon-danger" title="Удалить" aria-label={`Удалить ${f.name}`} onClick={() => setToDelete({ kind: "fixed", id: f.id, name: f.name })}><Trash2 size={14} /></button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <SubscriptionModal open={subModal} onClose={() => setSubModal(false)} editing={editSub} />
      <FixedModal open={fixedModal} onClose={() => setFixedModal(false)} editing={editFixed} />
      {/*
        Удаление регулярного платежа неоднозначно: пользователь мог ошибиться
        (тогда нужно удалить всё) или отключить платёж, но сохранить расход
        (тогда нужна одна запись на следующий месяц). Поэтому спрашиваем явно
        и выполняем именно выбранный вариант.
      */}
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        title={toDelete?.kind === "sub" ? "Удалить подписку?" : "Удалить обязательный платёж?"}
        text={`«${toDelete?.name}» — регулярный платёж. Выберите, что сделать с будущими списаниями.`}
        hint="Уже подтверждённые операции останутся в журнале при любом варианте."
        confirmLabel="Удалить полностью"
        onConfirm={() => {
          if (!toDelete) return;
          deleteRecurringSource(toDelete.kind, toDelete.id, "all");
        }}
        alternative={{
          label: "Отключить, но перенести на следующий месяц",
          hint: "Регулярный платёж будет удалён, а на следующий месяц появится одна операция на ту же сумму — её нужно будет подтвердить в срок.",
          onSelect: () => {
            if (!toDelete) return;
            deleteRecurringSource(toDelete.kind, toDelete.id, "carry");
          },
        }}
      />
    </div>
  );
}

/* ─────────────────────────── Вкладка «Подтвердить» ─────────────────────────── */

export function Confirm() {
  const { data, confirmPayment, skipPayment, go, removePending } = useApp();
  const currency = data.currency;
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean;
    pendingId: string | null;
    amount: number;
  }>({ open: false, pendingId: null, amount: 0 });
  const [skipModal, setSkipModal] = useState<{
    open: boolean;
    pendingId: string | null;
  }>({ open: false, pendingId: null });

  // Подтверждать нужно только то, что требует действия сейчас: просроченное
  // и текущего месяца. Платёж будущего месяца (создаётся заранее, чтобы не
  // потерять пропущенный месяц) показываем отдельно и подтверждения не просим —
  // раньше после подтверждения сразу появлялся «следующий месяц» с требованием
  // подтвердить, и это сбивало.
  const { actionable, planned } = useMemo(() => {
    const all = [...data.pendingPayments].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    return {
      actionable: all.filter((p) => isActionablePending(p)),
      planned: all.filter((p) => !isActionablePending(p)),
    };
  }, [data.pendingPayments]);

  const sorted = actionable;
  const total = sorted.reduce((s, p) => s + p.amount, 0);

  const valueFor = (p: PendingPayment): string => amounts[p.id] ?? String(p.amount);

  // Модальное окно для подтверждения с реальной суммой.
  // Именно функция, возвращающая разметку, а не компонент <ConfirmModalComponent />:
  // объявленный внутри тела компонента React считает новым типом на каждом
  // рендере, из-за чего открытая модалка перемонтировалась бы на любое
  // изменение состояния (в том числе на каждое нажатие клавиши в поле суммы),
  // и входная анимация проигрывалась заново.
  const renderConfirmModal = () => {
    if (!confirmModal.open || !confirmModal.pendingId) return null;
    
    const p = sorted.find(x => x.id === confirmModal.pendingId);
    if (!p) return null;

    const handleConfirm = () => {
      const amount = parseAmount(amounts[p.id] || String(p.amount));
      if (amount > 0) {
        confirmPayment(p.id, amount);
        setConfirmModal({ open: false, pendingId: null, amount: 0 });
        setAmounts((m) => { const r = { ...m }; delete r[p.id]; return r; });
      }
    };

    return (
      <Modal 
        open={confirmModal.open} 
        onClose={() => setConfirmModal({ open: false, pendingId: null, amount: 0 })}
        title={`Подтверждение: ${p.name}`}
      >
        <div className="space-y-4">
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Введите реальную сумму платежа. Она может отличаться от ожидаемой.
            {p.carryOverAmount && p.carryOverAmount > 0 && (
              <span className="block mt-2" style={{ color: "var(--warn)" }}>
                ⚠️ Включает перенесенные суммы: +{formatNumber(p.carryOverAmount, currency)}
              </span>
            )}
          </p>
          <Field label="Сумма">
            <input
              className="input mono"
              inputMode="decimal"
              value={amounts[p.id] || String(p.amount)}
              onChange={(e) => setAmounts((m) => ({ ...m, [p.id]: e.target.value.replace(/[^\d\s.,]/g, "") }))}
              autoFocus
            />
          </Field>
          <div className="flex gap-3 justify-end">
            <button className="btn btn-ghost" onClick={() => setConfirmModal({ open: false, pendingId: null, amount: 0 })}>
              Отмена
            </button>
            <button className="btn btn-primary" onClick={handleConfirm}>
              Подтвердить
            </button>
          </div>
        </div>
      </Modal>
    );
  };

  // Модальное окно для пропуска — по той же причине функция, а не компонент.
  const renderSkipModal = () => {
    if (!skipModal.open || !skipModal.pendingId) return null;
    
    const p = sorted.find(x => x.id === skipModal.pendingId);
    if (!p) return null;

    const handleSkip = (carryOver: boolean) => {
      if (skipModal.pendingId) {
        skipPayment(skipModal.pendingId, carryOver);
        setSkipModal({ open: false, pendingId: null });
      }
    };

    return (
      <Modal 
        open={skipModal.open} 
        onClose={() => setSkipModal({ open: false, pendingId: null })}
        title={`Пропуск: ${p.name}`}
      >
        <div className="space-y-4">
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Выберите, как поступить с этим платежом:
            {p.carryOverAmount && p.carryOverAmount > 0 && (
              <span className="block mt-2" style={{ color: "var(--warn)" }}>
                ⚠️ В этом платеже уже есть перенесенные суммы: +{formatNumber(p.carryOverAmount, currency)}
              </span>
            )}
          </p>
          <div className="space-y-3">
            <button 
              className="btn btn-ghost w-full justify-start"
              onClick={() => handleSkip(false)}
            >
              <div className="text-left">
                <div className="font-semibold" style={{ color: "var(--text)" }}>Пропустить без переноса</div>
                <div className="text-xs" style={{ color: "var(--muted)" }}>Платёж не будет учтён в следующем месяце</div>
              </div>
            </button>
            <button 
              className="btn btn-primary w-full justify-start"
              onClick={() => handleSkip(true)}
            >
              <div className="text-left">
                <div className="font-semibold">Учесть в следующем месяце</div>
                <div className="text-xs" style={{ color: "var(--on-accent)", opacity: 0.8 }}>
                  Сумма будет добавлена к следующему платежу
                </div>
              </div>
            </button>
          </div>
          <div className="flex gap-3 justify-end mt-4">
            <button className="btn btn-ghost" onClick={() => setSkipModal({ open: false, pendingId: null })}>
              Отмена
            </button>
          </div>
        </div>
      </Modal>
    );
  };

  return (
    <div>
      <PageHeader
        kicker="Ожидают действия"
        title="Подтверждение платежей"
        actions={
          sorted.length > 0 ? (
            <span className="chip-date mono">
              {sorted.length} {plural(sorted.length, "платёж", "платежа", "платежей")} · {formatNumber(total, currency)}
            </span>
          ) : undefined
        }
      />

      <section className="card cut p-5 rise-in">
        {sorted.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="Всё подтверждено"
            text="Ожидающих платежей нет. Новые появятся автоматически в день списания — загляните во вкладку «Платежи», чтобы настроить регулярные списания."
            action={<button className="btn btn-ghost" onClick={() => go("payments")}>К платежам</button>}
          />
        ) : (
          <ul className="space-y-3">
            {sorted.map((p) => {
              const dl = daysUntil(p.dueDate);
              const overdue = dl < 0;
              const n = parseAmount(valueFor(p));
              return (
                <li key={p.id} className="confirm-row">
                  <CategoryHex id={p.category} size={40} />
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                      <span className="text-sm font-semibold" style={{ color: "var(--text)" }}>{p.name}</span>
                      <span className="text-[11px]" style={{ color: "var(--muted)" }}>{categoryById(p.category).label}</span>
                    </div>
                    <span className="block text-[11px] mt-1" style={{ color: overdue ? "var(--danger)" : "var(--muted)" }}>
                      {formatDateShort(p.dueDate)} · {overdue ? `просрочен ${Math.abs(dl)} ${plural(Math.abs(dl), "день", "дня", "дней")}` : dl === 0 ? "оплата сегодня" : `через ${dl} ${plural(dl, "день", "дня", "дней")}`}
                    </span>
                  </div>
                  <input
                    className="input mono confirm-amount"
                    inputMode="decimal"
                    aria-label={`Фактическая сумма: ${p.name}`}
                    value={valueFor(p)}
                    onChange={(e) => setAmounts((m) => ({ ...m, [p.id]: e.target.value.replace(/[^\d\s.,]/g, "") }))}
                  />
                  <div className="flex gap-2">
                    <button
                      className="btn btn-ok"
                      disabled={n <= 0}
                      onClick={() => {
                        const amount = parseAmount(valueFor(p));
                        if (amount > 0) {
                          setConfirmModal({ open: true, pendingId: p.id, amount });
                        }
                      }}
                    >
                      <Check size={15} /> Подтвердить
                    </button>
                    <button 
                      className="btn btn-ghost" 
                      onClick={() => setSkipModal({ open: true, pendingId: p.id })}
                      title="Пропустить с выбором переноса"
                    >
                      <SkipForward size={14} /> Пропустить
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Платежи будущих месяцев: показываем, но подтверждения не требуем */}
      {planned.length > 0 && (
        <section className="card cut p-5 mt-4 rise-in">
          <header className="card-head">
            <h2 className="card-title">Запланировано</h2>
            <span className="card-sub"><CalendarClock size={14} /></span>
          </header>
          <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
            Эти списания ещё не требуют подтверждения — они появятся во вкладке «Подтвердить»
            в месяц списания.
          </p>
          <ul className="space-y-2">
            {planned.map((p) => (
              <li key={p.id} className="flex items-center gap-3 min-w-0">
                <CategoryHex id={p.category} size={30} />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm truncate" style={{ color: "var(--text)" }}>{p.name}</span>
                  <span className="block text-[11px]" style={{ color: "var(--muted)" }}>
                    {formatDateShort(p.dueDate)}
                  </span>
                </span>
                <span className="mono text-sm shrink-0" style={{ color: "var(--text)" }}>
                  {formatNumber(p.amount, currency)}
                </span>
                {/* Такой платёж не попадает в журнал, поэтому убрать его можно
                    только здесь — иначе он остался бы навсегда. */}
                <button
                  className="btn-icon btn-icon-danger"
                  title="Убрать из плана"
                  aria-label={`Убрать планируемый платёж ${p.name}`}
                  onClick={() => removePending(p.id)}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Модальные окна */}
      {renderConfirmModal()}
      {renderSkipModal()}

      <p className="text-xs mt-4 rise-in" style={{ color: "var(--muted)" }}>
        Подтверждение создаёт расход в журнале; следующий платёж появится в разделе «Запланировано» и не потребует подтверждения заранее. 
        Пропуск помечает платёж как «Пропущен» — вы можете выбрать, будет ли сумма учтена в этом же месяце.
        Если сумма превышает ожидаемую, остаток будет перенесён на следующий месяц.
        Сегодня: {formatDate(todayISO())}.
      </p>
    </div>
  );
}