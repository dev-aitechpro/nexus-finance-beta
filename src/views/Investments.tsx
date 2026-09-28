import { ArrowDownRight, ArrowUpRight, Calculator, Check, Pencil, Plus, Radio, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useApp } from "../hooks/AppProvider";
import { GrowthChart } from "../components/charts";
import { ConfirmDialog, EmptyState, Field, Modal, PageHeader, TickerHex, Toggle, useAnimatedNumber } from "../components/ui";
import { compoundFV, compoundSeries, monthsToTarget, portfolioStats } from "../lib/engine";
import type { Investment } from "../lib/types";
import { formatNumber, formatSigned, formatPct, parseAmount, plural, uid } from "../lib/utils";

const LIVE_KEY = "nexus.live.prices";

function AssetModal({ open, onClose, editing }: { open: boolean; onClose: () => void; editing: Investment | null }) {
  const { saveInvestment } = useApp();
  const [ticker, setTicker] = useState("");
  const [quantity, setQuantity] = useState("");
  const [buyPrice, setBuyPrice] = useState("");
  const [currentPrice, setCurrentPrice] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [seeded, setSeeded] = useState<string | null>(null);

  const key = editing?.id ?? "new";
  if (open && seeded !== key) {
    setSeeded(key);
    setTicker(editing?.ticker ?? "");
    setQuantity(editing ? String(editing.quantity) : "");
    setBuyPrice(editing ? String(editing.buyPrice) : "");
    setCurrentPrice(editing ? String(editing.currentPrice) : "");
    setErrors({});
  }
  if (!open && seeded !== null) setSeeded(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = parseAmount(quantity);
    const bp = parseAmount(buyPrice);
    const cp = parseAmount(currentPrice);
    const errs: Record<string, string> = {};
    if (!ticker.trim()) errs.ticker = "Укажите тикер";
    if (q <= 0) errs.quantity = "Количество больше нуля";
    if (bp <= 0) errs.buyPrice = "Цена покупки больше нуля";
    if (cp <= 0) errs.currentPrice = "Текущая цена больше нуля";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    saveInvestment({
      id: editing?.id ?? uid(),
      ticker: ticker.trim().toUpperCase(),
      quantity: q, buyPrice: bp, currentPrice: cp,
      createdAt: editing?.createdAt ?? new Date().toISOString(),
    });
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? "Редактировать актив" : "Новый актив"}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Тикер" error={errors.ticker}>
            <input className="input mono" placeholder="SBER" value={ticker} autoFocus
              onChange={(e) => setTicker(e.target.value.toUpperCase().slice(0, 6))} />
          </Field>
          <Field label="Количество" error={errors.quantity}>
            <input className="input mono" inputMode="decimal" placeholder="10" value={quantity}
              onChange={(e) => setQuantity(e.target.value.replace(/[^\d\s.,]/g, ""))} />
          </Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Цена покупки" error={errors.buyPrice}>
            <input className="input mono" inputMode="decimal" placeholder="0" value={buyPrice}
              onChange={(e) => setBuyPrice(e.target.value.replace(/[^\d\s.,]/g, ""))} />
          </Field>
          <Field label="Текущая цена" error={errors.currentPrice}>
            <input className="input mono" inputMode="decimal" placeholder="0" value={currentPrice}
              onChange={(e) => setCurrentPrice(e.target.value.replace(/[^\d\s.,]/g, ""))} />
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

export function Investments() {
  const { data, saveInvestment, deleteInvestment, tickPrices } = useApp();
  const currency = data.currency;
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<Investment | null>(null);
  const [toDelete, setToDelete] = useState<Investment | null>(null);
  const [priceEdit, setPriceEdit] = useState<string | null>(null);
  const [priceValue, setPriceValue] = useState("");

  const [live, setLive] = useState(() => {
    try { return localStorage.getItem(LIVE_KEY) !== "0"; } catch { return true; }
  });

  useEffect(() => {
    try { localStorage.setItem(LIVE_KEY, live ? "1" : "0"); } catch { /* noop */ }
    if (!live) return;
    const t = window.setInterval(() => tickPrices(), 4000);
    return () => window.clearInterval(t);
  }, [live, tickPrices]);

  const stats = useMemo(() => portfolioStats(data.investments), [data.investments]);
  const animatedValue = useAnimatedNumber(stats.value);

  /* Калькулятор сложного процента */
  const [p0, setP0] = useState("100000");
  const [monthly, setMonthly] = useState("15000");
  const [rate, setRate] = useState("12");
  const [years, setYears] = useState("10");
  const [target, setTarget] = useState("5000000");

  const calc = useMemo(() => {
    const cp0 = Math.max(0, parseAmount(p0));
    const cm = Math.max(0, parseAmount(monthly));
    const cr = Math.min(60, Math.max(0, parseAmount(rate)));
    const cy = Math.min(50, Math.max(1, Math.round(parseAmount(years) || 1)));
    const ct = Math.max(0, parseAmount(target));
    const final = compoundFV(cp0, cm, cr, cy * 12);
    const invested = cp0 + cm * cy * 12;
    const months = ct > 0 ? monthsToTarget(cp0, cm, cr, ct) : null;
    return {
      cp0, cm, cr, cy, ct, final, invested,
      series: compoundSeries(cp0, cm, cr, cy),
      doubling: cr > 0 ? 72 / cr : null,
      months,
    };
  }, [p0, monthly, rate, years, target]);

  const goalEta = calc.months === null
    ? "не достигается за 100 лет"
    : calc.months === 0
      ? "цель уже достигнута"
      : `${Math.floor(calc.months / 12)} ${plural(Math.floor(calc.months / 12), "год", "года", "лет")} ${calc.months % 12} мес.`;

  const commitPrice = (inv: Investment) => {
    const n = parseAmount(priceValue);
    if (n > 0) saveInvestment({ ...inv, currentPrice: n });
    setPriceEdit(null);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        kicker="Портфель"
        title="Инвестиции"
        actions={
          <>
            <label className="chip-date flex items-center gap-2 cursor-pointer">
              <Radio size={13} style={{ color: live ? "var(--ok)" : "var(--muted)" }} />
              <span>Live-котировки</span>
              <Toggle checked={live} onChange={setLive} label="Симуляция котировок" />
            </label>
            <button className="btn btn-primary" onClick={() => { setEditing(null); setModal(true); }}><Plus size={15} /> Актив</button>
          </>
        }
      />

      <section className="card cut kpi-strip rise-in" aria-label="Сводка портфеля">
        <div className="kpi-cell">
          <span className="kpi-label">Стоимость портфеля</span>
          <span className="kpi-value mono break-words" style={{ color: "var(--accent)" }}>{formatNumber(animatedValue, currency)}</span>
        </div>
        <div className="kpi-cell">
          <span className="kpi-label">Прибыль / убыток</span>
          <span className="kpi-value mono break-words" style={{ color: stats.profit >= 0 ? "var(--ok)" : "var(--pink)" }}>
            {formatSigned(stats.profit, currency)}
          </span>
          <span className="kpi-sub inline-flex items-center gap-1" style={{ color: stats.profit >= 0 ? "var(--ok)" : "var(--pink)" }}>
            {stats.profit >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}{formatPct(stats.pct)}
          </span>
        </div>
        <div className="kpi-cell">
          <span className="kpi-label">Вложено</span>
          <span className="kpi-value mono break-words">{formatNumber(stats.invested, currency)}</span>
        </div>
        <div className="kpi-cell">
          <span className="kpi-label">Активов</span>
          <span className="kpi-value mono break-words">{data.investments.length}</span>
        </div>
      </section>

      <section className="card cut overflow-hidden rise-in" style={{ animationDelay: "80ms" }}>
        {data.investments.length === 0 ? (
          <EmptyState
            icon={ArrowUpRight}
            title="Портфель пуст"
            text="Добавьте первый актив: тикер, количество и цены — NEXUS посчитает доходность и будет симулировать котировки."
            action={<button className="btn btn-primary" onClick={() => { setEditing(null); setModal(true); }}><Plus size={15} /> Добавить актив</button>}
          />
        ) : (
          <>
            <div className="ihead" aria-hidden>
              <span>Актив</span><span>Кол-во</span><span>Покупка</span><span>Цена (клик — изменить)</span><span className="text-right">Стоимость</span><span className="text-right">P&L</span><span />
            </div>
            <ul>
              {data.investments.map((inv) => {
                const value = inv.quantity * inv.currentPrice;
                const cost = inv.quantity * inv.buyPrice;
                const pnl = value - cost;
                const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
                const up = pnl >= 0;
                const isEdit = priceEdit === inv.id;
                return (
                  <li key={inv.id} className="irow">
                    <span className="icell-asset">
                      <TickerHex ticker={inv.ticker} color={up ? "var(--ok)" : "var(--pink)"} />
                      {/* Тикер ограничен 6 символами, но в шапке колонки (150px)
                          всё равно нужен min-w-0, иначе truncate не сработает. */}
                      <span className="font-display font-bold text-sm tracking-wider truncate min-w-0" style={{ color: "var(--text)" }}>{inv.ticker}</span>
                    </span>
                    {/* Суммы форматируются с неразрывным пробелом: в колонках
                        78/120/140/132px без переноса они выпирали наружу. */}
                    <span className="mono text-sm break-words" style={{ color: "var(--text)" }}>{inv.quantity}</span>
                    <span className="mono text-sm break-words" style={{ color: "var(--muted)" }}>{formatNumber(inv.buyPrice, currency)}</span>
                    <span>
                      {isEdit ? (
                        // flex-wrap: поле 118px + две кнопки не влезали в колонку
                        // 190px на телефоне и выталкивали строку за её пределы.
                        <span className="inline-flex flex-wrap items-center gap-1 min-w-0">
                          <input
                            className="input mono price-edit max-w-full"
                            inputMode="decimal"
                            value={priceValue}
                            autoFocus
                            aria-label={`Новая цена ${inv.ticker}`}
                            onChange={(e) => setPriceValue(e.target.value.replace(/[^\d\s.,]/g, ""))}
                            onBlur={() => commitPrice(inv)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitPrice(inv);
                              if (e.key === "Escape") setPriceEdit(null);
                            }}
                          />
                          <button className="btn-icon btn-icon-ok" onClick={() => commitPrice(inv)} aria-label="Сохранить цену"><Check size={14} /></button>
                          <button className="btn-icon" onClick={() => setPriceEdit(null)} aria-label="Отменить"><X size={14} /></button>
                        </span>
                      ) : (
                        <button
                          className="price-cell mono max-w-full"
                          title="Нажмите, чтобы изменить цену"
                          onClick={() => { setPriceEdit(inv.id); setPriceValue(String(inv.currentPrice)); }}
                        >
                          <Pencil size={11} style={{ color: "var(--muted)" }} />
                          <span key={inv.currentPrice} className="price-flash break-words">{formatNumber(inv.currentPrice, currency)}</span>
                        </button>
                      )}
                    </span>
                    <span className="mono text-sm font-semibold text-right break-words" style={{ color: "var(--text)" }}>{formatNumber(value, currency)}</span>
                    <span className="text-right">
                      <span className="mono text-sm font-semibold block break-words" style={{ color: up ? "var(--ok)" : "var(--pink)" }}>{formatSigned(pnl, currency)}</span>
                      <span className="mono text-[11px]" style={{ color: up ? "var(--ok)" : "var(--pink)" }}>{formatPct(pnlPct)}</span>
                    </span>
                    <span className="text-right">
                      <span className="flex gap-1 justify-end">
                        <button className="btn-icon" title="Редактировать" aria-label={`Редактировать ${inv.ticker}`} onClick={() => { setEditing(inv); setModal(true); }}><Pencil size={13} /></button>
                        <button className="btn-icon btn-icon-danger" title="Удалить" aria-label={`Удалить ${inv.ticker}`} onClick={() => setToDelete(inv)}><Trash2 size={13} /></button>
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      {/* Калькулятор сложного процента */}
      <section className="card cut p-5 rise-in" style={{ animationDelay: "160ms" }} aria-label="Калькулятор сложного процента">
        <header className="card-head">
          <h2 className="card-title">Калькулятор сложного процента</h2>
          <span className="card-sub"><Calculator size={14} className="inline" /> правило 72 · прогноз по годам</span>
        </header>
        <div className="grid lg:grid-cols-[300px_1fr] gap-6 mt-2">
          <div className="space-y-3.5">
            <Field label="Начальный капитал">
              <input className="input mono" inputMode="decimal" value={p0} onChange={(e) => setP0(e.target.value.replace(/[^\d\s.,]/g, ""))} />
            </Field>
            <Field label="Ежемесячный взнос">
              <input className="input mono" inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value.replace(/[^\d\s.,]/g, ""))} />
            </Field>
            <Field label="Доходность, % годовых">
              <input className="input mono" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value.replace(/[^\d\s.,]/g, ""))} />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Срок, лет">
                <input className="input mono" inputMode="numeric" value={years} onChange={(e) => setYears(e.target.value.replace(/\D/g, "").slice(0, 2))} />
              </Field>
              <Field label="Целевая сумма">
                <input className="input mono" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value.replace(/[^\d\s.,]/g, ""))} />
              </Field>
            </div>
            <dl className="pt-2 space-y-2 text-sm border-t" style={{ borderColor: "var(--line)" }}>
              <div className="flex justify-between gap-3 pt-2">
                <dt className="shrink-0" style={{ color: "var(--muted)" }}>Итоговый капитал</dt>
                <dd className="mono font-bold text-right min-w-0 break-words" style={{ color: "var(--accent)" }}>{formatNumber(calc.final, currency)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="shrink-0" style={{ color: "var(--muted)" }}>Чистая прибыль</dt>
                <dd className="mono font-semibold text-right min-w-0 break-words" style={{ color: "var(--ok)" }}>{formatSigned(calc.final - calc.invested, currency)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="shrink-0" style={{ color: "var(--muted)" }}>Удвоение капитала</dt>
                <dd className="mono text-right min-w-0 break-words" style={{ color: "var(--text)" }}>{calc.doubling ? `≈ ${calc.doubling.toFixed(1).replace(".", ",")} года` : "—"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="shrink-0" style={{ color: "var(--muted)" }}>До цели</dt>
                <dd className="mono text-right min-w-0 break-words" style={{ color: calc.months === null ? "var(--pink)" : "var(--text)" }}>{goalEta}</dd>
              </div>
            </dl>
          </div>
          <div>
            <GrowthChart points={calc.series} currency={currency} target={calc.ct > 0 ? calc.ct : null} />
          </div>
        </div>
      </section>

      <AssetModal open={modal} onClose={() => setModal(false)} editing={editing} />
      <ConfirmDialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        title="Удалить актив?"
        text={`${toDelete?.ticker ?? ""} будет удалён из портфеля. Стоимость портфеля пересчитается.`}
        onConfirm={() => toDelete && deleteInvestment(toDelete.id)}
      />
    </div>
  );
}
