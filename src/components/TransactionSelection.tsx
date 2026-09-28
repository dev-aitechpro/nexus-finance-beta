// src/components/TransactionSelection.tsx
// Панель массовых операций над выбранными операциями.
//
// Состояние выделения живёт в экране журнала (там кликают по строкам), а панель
// получает егоprops'ами. Раньше у компонента было своё независимое состояние:
// строки выделялись, а панель показывала «Выбрано: 0» и кнопка «Удалить
// выбранные» ничего не удаляла.
import { Trash2, CheckCircle2, Circle, Square, X } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "./ui";

export interface TransactionSelectionProps {
  /** Идентификаторы выбранных операций (состояние журнала). */
  selectedIds: Set<string>;
  /** Всего операций, доступных для выделения. */
  total: number;
  /** Снять всё выделение. */
  onClear: () => void;
  /** Выделить все доступные операции. */
  onSelectAll: () => void;
  /** Удалить выбранные. */
  onDelete: (ids: string[]) => void;
}

export function TransactionSelection({ selectedIds, total, onClear, onSelectAll, onDelete }: TransactionSelectionProps) {
  const [showConfirm, setShowConfirm] = useState(false);

  const count = selectedIds.size;
  const selectAll = total > 0 && count === total;
  const isIndeterminate = count > 0 && !selectAll;

  if (total === 0) return null;

  const confirmDelete = () => {
    onDelete(Array.from(selectedIds));
    setShowConfirm(false);
  };

  return (
    <div className="transaction-selection">
      {/* flex-wrap + gap-2: на ~360px четыре кнопки не помещались в одну
          строку и панель вылезала за край окна. */}
      <div className="flex flex-wrap items-center gap-2 mb-4 p-3 rounded-lg" style={{ backgroundColor: "var(--card)", border: "1px solid var(--line)" }}>
        <button
          className="flex items-center gap-2 btn btn-ghost btn-sm"
          onClick={onSelectAll}
          aria-label={selectAll ? "Снять выделение" : "Выбрать все"}
        >
          {selectAll ? (
            <CheckCircle2 size={16} style={{ color: "var(--accent)" }} />
          ) : isIndeterminate ? (
            <Square size={16} style={{ color: "var(--accent)" }} />
          ) : (
            <Circle size={16} />
          )}
          <span>{selectAll ? "Снять все" : isIndeterminate ? "Выбрано частично" : "Выбрать все"}</span>
        </button>

        <span className="text-sm min-w-0" style={{ color: "var(--muted)" }}>
          Выбрано: {count} из {total}
        </span>

        {count > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={onClear}>
            <X size={14} />
            <span>Очистить</span>
          </button>
        )}

        {count > 0 && (
          <button className="btn btn-danger btn-sm ml-auto" onClick={() => setShowConfirm(true)}>
            <Trash2 size={14} />
            <span>Удалить выбранные ({count})</span>
          </button>
        )}
      </div>

      <ConfirmDialog
        open={showConfirm}
        onClose={() => setShowConfirm(false)}
        title="Удалить выбранные операции?"
        text={`Будет удалено операций: ${count}. ${
          count === 1 ? "Операция" : "Операции"
        } из регулярных платежей удалятся вместе с подтверждением этого месяца — заново спрашивать не будем. Отменить это действие нельзя.`}
        confirmLabel="Да, удалить"
        onConfirm={confirmDelete}
      />
    </div>
  );
}
