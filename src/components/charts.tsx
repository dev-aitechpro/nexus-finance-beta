// src/components/charts.tsx
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import type { CashflowPoint, CompoundPoint } from "../lib/engine";
import type { Currency } from "../lib/types";
import { clamp, formatNumber } from "../lib/utils";

/* Тултип позиционируется в процентах ширины контейнера, поэтому на первом и
   последнем столбце он уезжал за правый край svg и наезжал на соседнюю
   карточку. Держим его в пределах 8…92% — места хватает и тултипу, и рамке. */
const TIP_MIN = 8;
const TIP_MAX = 92;

/* Стиль тултипа задаём инлайном: кастомный .chart-tooltip объявлен вне слоёв
   Tailwind и перебивает утилиты, а `white-space: nowrap` без ограничения
   ширины растягивал тултип длинной суммой. */
const tipStyle = (leftPct: number): CSSProperties => ({
  left: `${clamp(leftPct, TIP_MIN, TIP_MAX)}%`,
  transform: "none",
  maxWidth: "min(84%, 260px)",
  whiteSpace: "normal",
  overflowWrap: "anywhere",
  pointerEvents: "none",
});

/* ─────────────────────────── Денежный поток (бары) ─────────────────────────── */

export function CashflowChart({ data, currency }: { data: CashflowPoint[]; currency: Currency }) {
  const W = 640;
  const H = 250;
  const padT = 20;
  const padB = 28;
  const padR = 58; // 🔥 Безопасная зона справа для чисел
  const [hover, setHover] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // rAF не срабатывает в фоновой вкладке: без страховки по таймеру график
    // навсегда остался бы в стартовом состоянии (пустые столбцы).
    let raf = 0;
    const show = () => setMounted(true);
    raf = requestAnimationFrame(show);
    const timer = window.setTimeout(show, 60);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, []);

  const max = Math.max(1, ...data.map((d) => Math.max(d.income, d.expense)));
  const groupW = (W - padR) / data.length; // График рисуется только до padR
  const barW = Math.min(30, groupW * 0.24);
  const y = (v: number) => H - padB - (v / max) * (H - padB - padT);
  const ticks = [0.25, 0.5, 0.75, 1].map((t) => ({ v: max * t, yy: y(max * t) }));

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label="Денежный поток за 6 месяцев">
        {/* Линии сетки (доходят только до границы padR) */}
        {ticks.map((t) => (
          <g key={t.v}>
            <line x1={0} x2={W - padR} y1={t.yy} y2={t.yy} stroke="var(--line)" strokeDasharray="3 5" strokeWidth={1} />
            {/* 🔥 Суммы строго в безопасной зоне справа, выровнены по правому краю.
                Кегль 13 (в viewBox): на телефоне контейнер в 3–4 раза уже, и
                подписи 10px превращались в нечитаемую полосу. */}
            <text x={W - 4} y={t.yy - 6} textAnchor="end" fontSize={13} fill="var(--muted)">
              {formatNumber(t.v, currency, true)}
            </text>
          </g>
        ))}
        <line x1={0} x2={W - padR} y1={H - padB} y2={H - padB} stroke="var(--line)" strokeWidth={1} />
        
        {/* Столбцы графика (не заходят в безопасную зону) */}
        {data.map((d, i) => {
          const cx = i * groupW + groupW / 2;
          const active = hover === i;
          return (
            <g key={d.key} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
              <rect
                x={i * groupW} y={0} width={groupW} height={H - padB}
                fill={active ? "color-mix(in srgb, var(--accent) 7%, transparent)" : "transparent"}
                style={{ transition: "fill .2s" }}
              />
              <rect
                className="chart-bar"
                x={cx - barW - 2} width={barW} rx={3}
                y={y(d.income)}
                height={Math.max(0, H - padB - y(d.income))}
                fill="var(--ok)"
                opacity={active ? 1 : 0.82}
                // Только transform: прямоугольник рисуется сразу в конечных
                // координатах и «вырастает» от базовой линии (ТЗ п. 4.2 —
                // не анимируем layout-свойства, иначе на каждый кадр
                // пересчитывается раскладка).
                style={{
                  transformBox: "fill-box",
                  transformOrigin: "bottom",
                  transform: mounted ? "scaleY(1)" : "scaleY(0)",
                  transition: `transform .6s cubic-bezier(.2,.8,.2,1) ${i * 60}ms, opacity .2s`,
                }}
              />
              <rect
                className="chart-bar"
                x={cx + 2} width={barW} rx={3}
                y={y(d.expense)}
                height={Math.max(0, H - padB - y(d.expense))}
                fill="var(--pink)"
                opacity={active ? 1 : 0.82}
                style={{
                  transformBox: "fill-box",
                  transformOrigin: "bottom",
                  transform: mounted ? "scaleY(1)" : "scaleY(0)",
                  transition: `transform .6s cubic-bezier(.2,.8,.2,1) ${i * 60 + 40}ms, opacity .2s`,
                }}
              />
              <text x={cx} y={H - 9} textAnchor="middle" fontSize={14} fill={active ? "var(--text)" : "var(--muted)"} fontWeight={active ? 600 : 400}>
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>
      
      {hover !== null && (
        <div
          className="chart-tooltip"
          style={tipStyle(((hover + 0.5) / data.length) * 100)}
        >
          <span style={{ color: "var(--ok)" }}>▲ {formatNumber(data[hover].income, currency, true)}</span>
          <span style={{ color: "var(--pink)" }}>▼ {formatNumber(data[hover].expense, currency, true)}</span>
        </div>
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2 text-xs" style={{ color: "var(--muted)" }}>
        <span className="flex items-center gap-1.5"><i className="dot" style={{ background: "var(--ok)" }} /> Доходы</span>
        <span className="flex items-center gap-1.5"><i className="dot" style={{ background: "var(--pink)" }} /> Расходы</span>
      </div>
    </div>
  );
}

/* ─────────────────────────── Донат по категориям ─────────────────────────── */

export interface DonutSlice {
  id: string;
  label: string;
  value: number;
  color: string;
}

export function DonutChart({ slices, currency }: { slices: DonutSlice[]; currency: Currency }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // rAF не срабатывает в фоновой вкладке: без страховки по таймеру график
    // навсегда остался бы в стартовом состоянии (пустые столбцы).
    let raf = 0;
    const show = () => setMounted(true);
    raf = requestAnimationFrame(show);
    const timer = window.setTimeout(show, 60);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, []);

  const total = slices.reduce((s, x) => s + x.value, 0);
  const R = 62;
  const C = 2 * Math.PI * R;
  let acc = 0;

  return (
    /* Кольцо и легенда всегда друг под другом. Раньше был sm:flex-row —
       но sm — это ширина ОКНА, а карточка на дашборде ~310px даже на широком
       экране: в ряд не помещалось, легенда с w-full вылезала за карточку на
       ~60px и наезжала на соседний блок. Медиазапросы в CSS не знают про
       ширину контейнера, поэтому раскладку выбираем по гарантированному
       минимуму: 168px кольцо + подписи под ним. */
    <div className="flex flex-col items-center gap-4">
      <div className="relative shrink-0" style={{ width: 168, height: 168 }}>
        <svg viewBox="0 0 168 168" className="w-full h-full -rotate-90">
          <circle cx={84} cy={84} r={R} fill="none" stroke="var(--line)" strokeWidth={14} opacity={0.5} />
          {slices.map((s, i) => {
            const frac = total > 0 ? s.value / total : 0;
            const len = frac * C;
            const offset = acc;
            acc += len;
            return (
              <circle
                key={s.id}
                cx={84} cy={84} r={R} fill="none"
                stroke={s.color} strokeWidth={14} strokeLinecap="butt"
                strokeDasharray={mounted ? `${Math.max(0, len - 2.5)} ${C - len + 2.5}` : `0 ${C}`}
                strokeDashoffset={-offset}
                // Исключение из правила «только transform/opacity»: stroke-dasharray
                // не вызывает reflow (это paint-свойство SVG), зато даёт
                // «прорисовку» сектора, которую нельзя получить трансформацией.
                // На слабом устройстве переход отключается правилом в index.css.
                style={{ transition: `stroke-dasharray .7s cubic-bezier(.2,.8,.2,1) ${i * 70}ms`, filter: `drop-shadow(0 0 5px ${s.color}66)` }}
              />
            );
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center min-w-0 px-1">
          <span className="font-display font-bold text-base leading-tight break-words" style={{ color: "var(--text)" }}>
            {formatNumber(total, currency, true)}
          </span>
          <span className="text-[10px] uppercase tracking-[0.18em] mt-1" style={{ color: "var(--muted)" }}>расходы</span>
        </div>
      </div>
      <ul className="w-full min-w-0 space-y-2">
        {slices.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-3 text-sm donut-row">
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              <i className="dot shrink-0" style={{ background: s.color, boxShadow: `0 0 6px ${s.color}88` }} />
              <div className="flex flex-col min-w-0 leading-tight">
                <span className="truncate font-medium" style={{ color: "var(--text)" }}>{s.label}</span>
                <span className="text-[10px] text-[var(--muted)]">
                  {total > 0 ? Math.round((s.value / total) * 100) : 0}%
                </span>
              </div>
            </div>
            {/* 🔥 Убрали дублирующую сумму справа, оставили только проценты. 
                Итоговая сумма и так видна в центре доната. */}
          </li>
        ))}
        {/* 🔥 Добавили общую сумму расходов внизу списка для ясности */}
        <li className="pt-3 mt-2 border-t border-[var(--line)] flex justify-between gap-3 text-xs text-[var(--muted)]">
          <span className="min-w-0 truncate">Всего расходов</span>
          <span className="mono font-semibold text-[var(--text)] text-right min-w-0 break-words">{formatNumber(total, currency, true)}</span>
        </li>
      </ul>
    </div>
  );
}

/* ─────────────────────────── Рост капитала (область) ─────────────────────────── */

export function GrowthChart({
  points, currency, target,
}: {
  points: CompoundPoint[]; currency: Currency; target: number | null;
}) {
  const W = 640;
  const H = 260;
  const padL = 12;
  const padR = 58; // 🔥 Безопасная зона справа
  const padT = 16;
  const padB = 28;
  const [hover, setHover] = useState<number | null>(null);
  const [drawn, setDrawn] = useState(false);
  const pathRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDrawn(true), 60);
    return () => clearTimeout(t);
  }, []);

  const max = Math.max(1, ...points.map((p) => p.value), target ?? 0) * 1.06;
  const x = (i: number) => padL + (i / Math.max(1, points.length - 1)) * (W - padL - padR);
  const y = (v: number) => H - padB - (v / max) * (H - padB - padT);

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${x(points.length - 1).toFixed(1)},${H - padB} L${x(0).toFixed(1)},${H - padB} Z`;
  const investedPath = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.invested).toFixed(1)}`).join(" ");

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.round(((px - padL) / (W - padL - padR)) * (points.length - 1));
    setHover(Math.min(points.length - 1, Math.max(0, idx)));
  };

  return (
    <div className="relative">
      {/* События указателя, а не мыши: на телефоне после отпускания пальца
          mouseleave не приходит, и тултип залипал до следующего касания.
          touch-action: pan-y — горизонтальное ведём сами, вертикальное
          отдаём прокрутке страницы, иначе график нельзя «протереть». */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto block"
        style={{ touchAction: "pan-y" }}
        role="img"
        aria-label="График роста капитала"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onPointerCancel={() => setHover(null)}
      >
        <defs>
          <linearGradient id="growthFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.34" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(max * t)} y2={y(max * t)} stroke="var(--line)" strokeDasharray="3 5" />
            {/* 🔥 Суммы строго в безопасной зоне справа (кегль 13 — читаемо на телефоне) */}
            <text x={W - 4} y={y(max * t) - 6} textAnchor="end" fontSize={13} fill="var(--muted)">
              {formatNumber(max * t, currency, true)}
            </text>
          </g>
        ))}
        {target !== null && target > 0 && target <= max && (
          <g>
            <line x1={padL} x2={W - padR} y1={y(target)} y2={y(target)} stroke="var(--pink)" strokeWidth={1.4} strokeDasharray="6 5" />
            {/* Подпись цели уводим внутрь области графика и прижимаем влево:
                раньше она стояла справа перед цифрами оси и накладывалась на них.
                Обводка цветом карточки отделяет подпись от линии графика. */}
            <text x={padL + 4} y={y(target) - 6} textAnchor="start" fontSize={14} fill="var(--pink)" fontWeight={600}
              stroke="var(--card-solid)" strokeWidth={3} paintOrder="stroke">
              цель {formatNumber(target, currency, true)}
            </text>
          </g>
        )}
        <path d={areaPath} fill="url(#growthFill)" opacity={drawn ? 1 : 0} style={{ transition: "opacity .9s ease .25s" }} />
        <path
          ref={pathRef}
          d={linePath} fill="none" stroke="var(--accent)" strokeWidth={2.4} strokeLinejoin="round"
          strokeDasharray={1600}
          strokeDashoffset={drawn ? 0 : 1600}
          style={{ transition: "stroke-dashoffset 1.1s cubic-bezier(.3,.7,.3,1)", filter: "drop-shadow(0 0 6px color-mix(in srgb, var(--accent) 60%, transparent))" }}
        />
        <path d={investedPath} fill="none" stroke="var(--muted)" strokeWidth={1.6} strokeDasharray="5 6" opacity={0.8} />
        {/* Крайние подписи прижимаем к границам области графика (start/end),
            иначе при fontSize 14 первая и последняя вылезали за viewBox. */}
        {points.map((p, i) => (
          (p.year % Math.max(1, Math.ceil(points.length / 8)) === 0 || i === points.length - 1) && (
            <text
              key={p.year}
              x={i === 0 ? padL : i === points.length - 1 ? W - padR : x(i)}
              y={H - 9}
              textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
              fontSize={14}
              fill="var(--muted)"
            >
              {p.year} г.
            </text>
          )
        ))}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB} stroke="var(--accent)" strokeWidth={1} opacity={0.55} />
            <circle cx={x(hover)} cy={y(points[hover].value)} r={4.5} fill="var(--accent)" stroke="var(--bg)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hover !== null && (
        <div className="chart-tooltip" style={tipStyle((x(hover) / W) * 100)}>
          <span style={{ color: "var(--accent)" }}>{points[hover].year} лет — {formatNumber(points[hover].value, currency, true)}</span>
          <span style={{ color: "var(--muted)" }}>вложено {formatNumber(points[hover].invested, currency, true)}</span>
        </div>
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2 text-xs" style={{ color: "var(--muted)" }}>
        <span className="flex items-center gap-1.5"><i className="dot" style={{ background: "var(--accent)" }} /> Капитал</span>
        <span className="flex items-center gap-1.5"><i className="dot" style={{ background: "var(--muted)" }} /> Вложено</span>
      </div>
    </div>
  );
}