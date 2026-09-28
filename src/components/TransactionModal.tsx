import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useApp } from "../hooks/AppProvider";
import { CATEGORIES } from "../lib/constants";
import type { TransactionInput, TxSource, TxType } from "../lib/types";
import { parseAmount, todayISO } from "../lib/utils";
import { CategoryPicker } from "./CategoryPicker";
import { Field, Modal, Segmented } from "./ui";

export function TransactionModal() {
  const { txModal, closeTxModal, addTransaction, updateTransaction } = useApp();
  const { open, editing, preset } = txModal;

  const [type, setType] = useState<TxType>("expense");
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(todayISO());
  const [source, setSource] = useState<TxSource>("manual");
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setType(editing.type);
      setCategory(editing.category);
      setAmount(String(editing.amount));
      setDescription(editing.description ?? "");
      setDate(editing.date);
      setSource(editing.source);
    } else {
      setType(preset.type ?? "expense");
      setCategory(preset.category ?? "");
      setAmount(preset.amount ? String(preset.amount) : "");
      setDescription(preset.description ?? "");
      setDate(preset.date ?? todayISO());
      setSource(preset.source ?? "manual");
    }
    setErrors({});
  }, [open, editing, preset]);

  const cats = useMemo(() => CATEGORIES.filter((c) => c.type === type), [type]);

  useEffect(() => {
    if (cats.length > 0 && !cats.some((c) => c.id === category)) {
      setCategory(cats[0].id);
    }
  }, [cats, category]);

  const blurAmount = () => {
    const n = parseAmount(amount);
    if (n > 0) setAmount(n.toLocaleString("ru-RU", { maximumFractionDigits: 2 }));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = parseAmount(amount);
    const errs: Record<string, string> = {};
    if (n <= 0) errs.amount = "Сумма должна быть больше нуля";
    if (!category) errs.category = "Выберите категорию";
    if (!date) errs.date = "Укажите дату";
    else if (date > todayISO()) errs.date = "Дата не может быть в будущем";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const input: TransactionInput = {
      type, category, amount: n,
      description: description.trim() || null,
      date, source,
    };
    if (editing) updateTransaction(editing.id, input);
    else addTransaction(input);
    closeTxModal();
  };

  return (
    <Modal open={open} onClose={closeTxModal} title={editing ? "Редактирование транзакции" : "Новая транзакция"}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Segmented<TxType>
          options={[
            { value: "expense", label: "Расход" },
            { value: "income", label: "Доход" },
          ]}
          value={type}
          onChange={setType}
        />

        <div className="grid grid-cols-2 gap-4">
          <Field label="Сумма" error={errors.amount}>
            <input
              className="input mono"
              inputMode="decimal"
              placeholder="0"
              value={amount}
              autoFocus
              onChange={(e) => setAmount(e.target.value.replace(/[^\d\s.,]/g, ""))}
              onBlur={blurAmount}
            />
          </Field>
          <Field label="Дата" error={errors.date}>
            <input className="input" type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>

        <Field label="Категория" error={errors.category}>
          <CategoryPicker value={category} onChange={setCategory} type={type} error={errors.category} />
        </Field>

        <Field label="Источник">
          <select className="input" value={source} onChange={(e) => setSource(e.target.value as TxSource)}>
            <option value="manual">Ручная</option>
            <option value="subscription">Подписка</option>
            <option value="payment">Платёж</option>
            <option value="goal">Цель</option>
          </select>
        </Field>

        <Field label="Описание" hint="Необязательно">
          <input
            className="input"
            placeholder="Например: Пятёрочка"
            value={description}
            maxLength={80}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <div className="flex justify-end gap-3 pt-1">
          <button type="button" className="btn btn-ghost" onClick={closeTxModal}>Отмена</button>
          <button type="submit" className="btn btn-primary">
            {editing ? "Сохранить" : "Добавить"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
