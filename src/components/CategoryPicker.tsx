// src/components/CategoryPicker.tsx
// Выбор категории с иконками вместо нативного <select>.
//
// Почему не <select>: в стандартном списке нельзя показать иконку и цвет
// категории — пользователь выбирал «Продукты» вслепую, а в готовой операции
// иконка появлялась сама. Здесь выбор всегда с иконкой, поэтому иконка
// не может «не сконвертироваться»: она часть самой кнопки.
import { useEffect, useRef } from "react";
import { riseInKeyframes, stagger } from "../animations/waapi";
import { useCapabilities } from "../hooks/useCapabilities";
import { CATEGORIES } from "../lib/constants";
import type { Category, TxType } from "../lib/types";
import { CategoryHex } from "./ui";
import { cn } from "../utils/cn";

export interface CategoryPickerProps {
  value: string;
  onChange: (id: string) => void;
  /** Фильтр по типу: расходы или доходы. Не задано — показываем все. */
  type?: TxType;
  /** Только иконки, без подписей (узкие места). */
  compact?: boolean;
  error?: string;
}

export function CategoryPicker({ value, onChange, type, compact = false, error }: CategoryPickerProps) {
  const caps = useCapabilities();
  const gridRef = useRef<HTMLDivElement>(null);
  const shown = useRef<Set<string>>(new Set());
  const list: Category[] = CATEGORIES.filter((c) => (type ? c.type === type : true));

  // Появление плиток: лимит одновременных анимаций (ТЗ Группа 3) и мгновенный
  // показ на слабом устройстве или при prefers-reduced-motion.
  useEffect(() => {
    const root = gridRef.current;
    if (!root) return;
    const fresh = [...root.children].filter((el) => {
      const id = el.getAttribute("data-cat") ?? "";
      if (shown.current.has(id)) return false;
      shown.current.add(id);
      return true;
    });
    if (fresh.length === 0) return;
    stagger(fresh as HTMLElement[], () => riseInKeyframes(6), {
      duration: 260,
      stepMs: 28,
      limit: 8,
      reduced: caps.reducedMotion,
      lowEnd: caps.lowEnd,
    });
  }, [caps.lowEnd, caps.reducedMotion, list.length, type]);

  return (
    <div
      ref={gridRef}
      role="radiogroup"
      aria-label="Категория"
      className={cn("cat-picker", compact && "cat-picker-compact")}
      style={error ? { borderColor: "var(--danger)" } : undefined}
    >
      {list.map((c) => {
        const active = c.id === value;
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={active}
            data-cat={c.id}
            className={cn("cat-item", active && "cat-item-active")}
            style={
              active
                ? {
                    borderColor: `color-mix(in srgb, ${c.color} 60%, transparent)`,
                    background: `color-mix(in srgb, ${c.color} 12%, transparent)`,
                  }
                : undefined
            }
            onClick={() => onChange(c.id)}
            title={c.label}
          >
            <CategoryHex id={c.id} size={compact ? 30 : 34} />
            {!compact && (
              <span
                className="cat-item-label truncate"
                style={{ color: active ? c.color : "var(--muted)" }}
              >
                {c.label}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Компактная строка чипов — там, где сетка не помещается (сканер, фильтры). */
export function CategoryChipRow({
  value,
  onChange,
  type = "expense",
}: {
  value: string;
  onChange: (id: string) => void;
  type?: TxType;
}) {
  const list = CATEGORIES.filter((c) => c.type === type);
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map((c) => (
        <button
          key={c.id}
          type="button"
          className={cn("chip cat-chip", c.id === value && "cat-chip-active")}
          style={c.id === value ? { borderColor: c.color, color: c.color } : undefined}
          onClick={() => onChange(c.id)}
          aria-pressed={c.id === value}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
