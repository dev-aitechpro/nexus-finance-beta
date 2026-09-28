// src/components/ui.tsx
import {
  Briefcase, Bus, CheckCircle2, Clock, Gamepad2, Gift, GraduationCap,
  HeartPulse, Home, Laptop, MoreHorizontal, PiggyBank, Plane, PlusCircle,
  Repeat, ShoppingBag, ShoppingCart, SkipForward, TrendingUp, UtensilsCrossed, X,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback, useEffect, useId, useRef, useState,
  type ChangeEvent, type ReactNode, type KeyboardEvent,
} from "react";
import { createValueTransition } from "../animations/ticker";
import {
  animate, collapseOutKeyframes, EASE_OUT, fadeOutKeyframes, pressPop,
  resolveMotionPlan, riseIn, riseInKeyframes, scaleProgress, stagger,
  type MotionPreferences,
} from "../animations/waapi";
import { useCapabilities } from "../hooks/useCapabilities";
import { useOverlay } from "../hooks/useOverlayStack";
import { useApp } from "../hooks/AppProvider";
import { categoryById } from "../lib/constants";
import type { Toast, TxStatus } from "../lib/types";
import { cn } from "../utils/cn";

/* ─────────────────────────── Общие настройки движения ─────────────────────────── */

/** Выход модального окна: 160 мс — заметно, но не задерживает работу. */
const MODAL_EXIT_MS = 160;
/** Уход тоста: сначала гаснет (180 мс), потом схлопывается (180 мс). */
const TOAST_EXIT_MS = 180;
const TOAST_COLLAPSE_MS = 180;
/** Отклик на нажатие. */
const PRESS_MS = 120;
/**
 * ТЗ п. 4.3: одновременно не больше 8–10 анимаций. Запас к длительности —
 * страховка на случай, если событие finished не придёт (например, анимацию
 * сняли извне или вкладка ушла в фон).
 */
const MAX_PRESS_ANIMATIONS = 8;
const EXIT_GRACE_MS = 60;

/* ─────────────────────────── Иконки категорий ─────────────────────────── */

export const CATEGORY_ICONS: Record<string, LucideIcon> = {
  briefcase: Briefcase, laptop: Laptop, trending: TrendingUp, gift: Gift,
  plus: PlusCircle, cart: ShoppingCart, utensils: UtensilsCrossed, bus: Bus,
  home: Home, repeat: Repeat, gamepad: Gamepad2, pulse: HeartPulse,
  bag: ShoppingBag, grad: GraduationCap, plane: Plane, piggy: PiggyBank,
  dots: MoreHorizontal,
};

export function CategoryHex({ id, size = 38 }: { id: string; size?: number }) {
  const cat = categoryById(id);
  const Icon = CATEGORY_ICONS[cat.icon] ?? MoreHorizontal;
  return (
    <span
      className="hex flex items-center justify-center shrink-0"
      style={{
        width: size, height: size,
        background: `linear-gradient(160deg, ${cat.color}33, ${cat.color}14)`,
        // Контур рисует .hex через inset-тень по clip-path; рамку в разметке
        // не ставим, иначе поверх неё ляжет вторая тонкая линия.
        color: cat.color,
      }}
      aria-hidden
    >
      <Icon size={size * 0.44} strokeWidth={1.8} />
    </span>
  );
}

export function TickerHex({ ticker, size = 40, color = "var(--accent)" }: { ticker: string; size?: number; color?: string }) {
  return (
    <span
      className="hex flex items-center justify-center shrink-0 font-display"
      style={{
        width: size, height: size,
        background: `linear-gradient(160deg, color-mix(in srgb, ${color} 26%, transparent), transparent)`,
        color, fontSize: size * 0.24, letterSpacing: "0.04em",
      }}
      aria-hidden
    >
      {ticker.slice(0, 4)}
    </span>
  );
}

/* ─────────────────────────── Focus Trap ─────────────────────────── */

export function FocusTrap({ children, active = true }: { children: ReactNode; active?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    
    const container = containerRef.current;
    if (!container) return;

    const focusable = container.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;

    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;

    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', handleKeyDown);
    return () => container.removeEventListener('keydown', handleKeyDown);
  }, [active]);

  return <div ref={containerRef}>{children}</div>;
}

/* ─────────────────────────── Отклик на нажатие ─────────────────────────── */

/**
 * Классы, которые откликаются нажатием. Список взят из разметки и index.css:
 * кнопки, иконки-кнопки, чипы, сегменты, пагинация, плитки категорий, карточки
 * тем и навигация. Класса .seg-btn в проекте нет — сегменты называются
 * .segmented-btn, а .cat-chip/.chip-big — это те же .chip, но со своими
 * hover-трансформациями, поэтому перечислены явно.
 *
 * Строки списков (журнал, инвестиции, быстрые списки) и текстовые ссылки
 * (.jhead-sort, .card-link, .link) сюда не входят: у них нет ни одного из
 * этих классов, поэтому на длинных списках лишних анимаций не появляется.
 */
const PRESSABLE_SELECTOR = [
  ".btn", ".btn-icon", ".chip", ".chip-big", ".cat-item", ".cat-chip",
  ".segmented-btn", ".page-btn", ".theme-card", ".toggle",
  ".nav-item", ".mobile-nav-btn",
].join(", ");

/** Клавиатурное нажатие: Enter и Space (в т.ч. старый псевдоним). */
const PRESSABLE_KEYS = new Set(["Enter", " ", "Spacebar"]);

/** Поля ввода: клавиши там не «нажимают кнопку», поэтому их пропускаем. */
const TEXT_FIELD_SELECTOR = "input, textarea, select, [contenteditable]";

/**
 * Сколько откликов играет прямо сейчас — счётчик одновременных анимаций
 * (ТЗ п. 4.3). Сами анимации живут в реестре waapi.ts; здесь только учёт,
 * чтобы не запускать больше лимита сразу.
 */
const activePresses = new Set<HTMLElement>();

/** Настройки последнего рендера: обработчики читают их в момент события. */
let pressPrefs: MotionPreferences = { reduced: false, lowEnd: false };

const findPressable = (target: EventTarget | null): HTMLElement | null => {
  if (!target || typeof (target as Element).closest !== "function") return null;
  const el = (target as Element).closest<HTMLElement>(PRESSABLE_SELECTOR);
  if (!el) return null;
  // Выключенный элемент не откликается: у .btn:disabled и .btn-icon:disabled
  // в index.css pointer-events: none, но у role=button событие ещё дойдёт.
  if (el.matches(":disabled") || el.getAttribute("aria-disabled") === "true") return null;
  return el;
};

/**
 * Короткий «отскок». fill: "none" обязателен (см. комментарий в waapi.ts):
 * с fill: "both" конечный кадр scale(1) навсегда перекрыл бы CSS-подъём на
 * hover и :active у .btn.
 */
const popPress = (el: HTMLElement, prefs: MotionPreferences): void => {
  if (activePresses.size >= MAX_PRESS_ANIMATIONS && !activePresses.has(el)) return;
  const animation = pressPop(el, PRESS_MS, { prefs, fill: "none" });
  if (!animation) return; // деградация: кнопка просто не отскакивает
  activePresses.add(el);
  const release = (): void => {
    activePresses.delete(el);
  };
  // finished резолвится и при отмене, поэтому отпускаем слот в обоих случаях;
  // таймер — страховка, если finished не придёт вовсе.
  void animation.finished.then(release, release);
  window.setTimeout(release, PRESS_MS + EXIT_GRACE_MS);
};

const onPressPointerDown = (e: globalThis.PointerEvent): void => {
  if (e.button !== 0) return; // правая кнопка и средняя — не нажатие
  const el = findPressable(e.target);
  if (el) popPress(el, pressPrefs);
};

const onPressKeyDown = (e: globalThis.KeyboardEvent): void => {
  if (e.repeat || !PRESSABLE_KEYS.has(e.key)) return;
  const target = e.target;
  if (target instanceof Element && target.matches(TEXT_FIELD_SELECTOR)) return;
  const el = findPressable(target);
  // Нажимать можно и <button>, и [role=button] — второй случай закрывает
  // нестандартные переключатели, если их добавят в разметку.
  if (!el || (el.tagName !== "BUTTON" && !el.getAttribute("role"))) return;
  popPress(el, pressPrefs);
};

/**
 * Число подписчиков глобального слушателя. Именно счётчик, а не набор
 * обработчиков: хук могут вызвать дважды (например, ToastHost и AppShell) —
 * слушатель в DOM всё равно должен быть один, иначе одно нажатие запустит
 * два отскока.
 */
let pressSubscribers = 0;

const subscribePress = (): (() => void) => {
  pressSubscribers += 1;
  if (pressSubscribers === 1) {
    // passive: слушатель только читает событие и ничего не блокирует,
    // поэтому прокрутку и жесты он перехватывать не может (ТЗ п. 4.1).
    document.addEventListener("pointerdown", onPressPointerDown, { passive: true });
    document.addEventListener("keydown", onPressKeyDown, { passive: true });
  }
  return () => {
    pressSubscribers = Math.max(0, pressSubscribers - 1);
    if (pressSubscribers === 0) {
      document.removeEventListener("pointerdown", onPressPointerDown);
      document.removeEventListener("keydown", onPressKeyDown);
    }
  };
};

/**
 * Один делегированный слушатель на весь документ вместо обработчика на
 * каждой кнопке: иначе React вешал бы onPointerDown на сотни кнопок, а
 * список пересоздавался бы на каждом рендере.
 *
 * Вешается в ToastHost (он смонтирован в App всегда). Чтобы перенести в
 * AppShell, достаточно вызвать хук там — второй подписчик не создаст второго
 * слушателя. Снимается при размонтировании.
 */
export function usePressFeedback(): void {
  const caps = useCapabilities();
  // Без массива зависимостей: значение должно быть свежим в момент нажатия,
  // а переподписывать слушатель при смене настроек не нужно.
  useEffect(() => {
    pressPrefs = { reduced: caps.reducedMotion, lowEnd: caps.lowEnd };
  });
  useEffect(() => subscribePress(), []);
}

/* ─────────────────────────── Модальные окна ─────────────────────────── */

export function Modal({
  open, onClose, title, children, wide = false,
}: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const caps = useCapabilities();

  /**
   * Аппаратная кнопка «Назад»: открытое окно встаёт в стек оверлеев
   * (hooks/useOverlayStack) и закрывается им же — Escape на телефоне нет,
   * а «Назад» до сих пор знал только про модалку транзакции. На регистрацию
   * попадают все окна на этом компоненте, включая ConfirmDialog.
   *
   * onClose берём из ref: он у родителя — новая стрелка на каждом рендере,
   * и без ref смена идентичности переподписывала бы стек на каждом кадре,
   * оставляя в нём лишние записи. Сама подписка зависит только от `open`
   * (это делает useOverlay), поэтому на время выхода запись уже снята.
   */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useOverlay(open, () => onCloseRef.current());

  /**
   * Копия состояния: окно живёт в DOM, пока идёт выход.
   * Раньше `if (!open) return null` убирало его тем же кадром, что и
   * открытие было false — вход анимировался CSS-классом .modal-panel,
   * а выхода не было вовсе, поэтому окно просто исчезало.
   *
   * Копия нужна ещё и потому, что родитель при закрытии обычно обнуляет
   * данные (closeTxModal сбрасывает editing/preset): без копии содержимого
   * окно мигало бы пустым, пока играет уход. Родитель может рендерить
   * <Modal> и условно — тогда копия всё равно держит разметку до конца анимации.
   */
  const [mounted, setMounted] = useState(open);
  const lastChildren = useRef<ReactNode>(children);
  if (open) lastChildren.current = children;
  // Открытие после полностью смонтированного выхода: возвращаем элемент в DOM.
  if (open && !mounted) setMounted(true);

  /** Снять анимацию выхода и её таймер (повторное открытие / размонтирование). */
  const exitRef = useRef<{ animations: Animation[]; timer: number | null }>({ animations: [], timer: null });
  const capsRef = useRef(caps);
  capsRef.current = caps;

  const stopExit = useCallback((): void => {
    for (const animation of exitRef.current.animations) animation.cancel();
    if (exitRef.current.timer !== null) window.clearTimeout(exitRef.current.timer);
    exitRef.current = { animations: [], timer: null };
  }, []);

  // Снимаем анимацию, если окно размонтировали извне.
  useEffect(() => stopExit, [stopExit]);

  /**
   * Выход: open=false больше не убирает окно, а запускает короткую
   * анимацию. Повторное открытие во время ухода её прерывает (cancel),
   * поэтому окно не «залипает» полупрозрачным, а таймер не срабатывает
   * для уже открытого окна.
   */
  useEffect(() => {
    if (open) {
      stopExit();
      return;
    }
    if (!mounted) return; // окно уже размонтировано — выхода нечего играть
    const capsNow = capsRef.current;
    const prefs: MotionPreferences = { reduced: capsNow.reducedMotion, lowEnd: capsNow.lowEnd };
    const plan = resolveMotionPlan({ duration: MODAL_EXIT_MS, easing: EASE_OUT }, prefs);
    if (!plan.enabled) {
      // Слабое устройство или «уменьшить движение»: размонтируем сразу (ТЗ Группа 4).
      setMounted(false);
      return;
    }
    const panel = modalRef.current;
    const overlay = overlayRef.current;
    // Подложка гаснет, панель схлопывается — всего две короткие анимации.
    // Разметку .modal-overlay/.modal-panel не трогаем: CSS-вход продолжает работать.
    const animations = [
      animate(overlay, [{ opacity: 1 }, { opacity: 0 }], {
        duration: plan.duration, easing: plan.easing, prefs,
      }),
      animate(panel, collapseOutKeyframes(10, 0.98), {
        duration: plan.duration, easing: plan.easing, prefs,
      }),
    ].filter((a): a is Animation => a !== null);
    exitRef.current = {
      animations,
      // Страховка на случай, если событие finished не придёт.
      timer: window.setTimeout(() => {
        exitRef.current = { animations: [], timer: null };
        setMounted(false);
      }, plan.duration + EXIT_GRACE_MS),
    };
  }, [open, mounted, stopExit]);

  useEffect(() => {
    if (!open) return;
    
    // Фокус. Раньше брали первый интерактивный элемент в порядке документа, а
    // в шапке модалки первым стоит крестик — фокус всегда уезжал на него.
    // На телефоне это было хуже некрасиво: у поля суммы стоит autoFocus,
    // React открывал клавиатуру, а через 100 мс этот таймер уводил фокус на
    // крестик, и клавиатура гасла. Поэтому сначала ищем именно ПОЛЕ ввода,
    // и только на устройствах без клавиатуры — кнопку.
    const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    const panel = modalRef.current;
    const firstField = panel?.querySelector<HTMLElement>(
      'input:not([disabled]):not([type="hidden"]), textarea:not([disabled])',
    );
    const focusTarget =
      (coarse ? firstField : firstField ?? panel?.querySelector<HTMLElement>('button:not([disabled])')) ?? null;
    const focusTimer = focusTarget ? window.setTimeout(() => focusTarget.focus(), coarse ? 260 : 100) : null;
    
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const focusableElements = modalRef.current?.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'
        );
        if (!focusableElements || focusableElements.length === 0) return;
        
        const first = focusableElements[0] as HTMLElement;
        const last = focusableElements[focusableElements.length - 1] as HTMLElement;
        
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    
    window.addEventListener("keydown", onKey);
    return () => {
      // Фокус не перехватываем, если окно уже начало закрываться.
      if (focusTimer !== null) window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  /**
   * Содержимое подскакивает следом за панелью: transform + opacity, без
   * пересчёта раскладки (ТЗ п. 4.2). fill: "backwards" обязателен — из-за
   * задержки первый кадр должен применяться до старта, иначе содержимое
   * мелькнёт в обычном состоянии. На деградации riseIn не запускается.
   */
  useEffect(() => {
    if (!open) return;
    riseIn(bodyRef.current, 8, 240, {
      delay: 60,
      fill: "backwards",
      reduced: caps.reducedMotion,
      lowEnd: caps.lowEnd,
    });
  }, [open, caps.reducedMotion, caps.lowEnd]);

  // Окно остаётся в DOM на время выхода; размонтирует его только таймер
  // в эффекте выше (или деградация — сразу).
  if (!open && !mounted) return null;
  const content = open ? children : lastChildren.current;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      // Пока идёт уход, окно не должно ловить нажатия и фокус.
      style={open ? undefined : { pointerEvents: "none" }}
    >
      <button 
        ref={overlayRef}
        className="modal-overlay absolute inset-0 cursor-default" 
        onClick={onClose} 
        aria-label="Закрыть" 
        tabIndex={-1} 
      />
      <div ref={modalRef} className={cn("modal-panel card relative w-full overflow-y-auto", wide ? "max-w-2xl" : "max-w-md")}>
        <div className="flex items-center justify-between gap-4 px-5 pt-4 pb-3 border-b" style={{ borderColor: "var(--line)" }}>
          <h2 className="font-display text-sm tracking-[0.14em] uppercase" style={{ color: "var(--text)" }}>{title}</h2>
          <button className="btn-icon" onClick={onClose} aria-label="Закрыть окно"><X size={16} /></button>
        </div>
        <div ref={bodyRef} className="p-5">{content}</div>
      </div>
    </div>
  );
}

/**
 * Нижняя шторка: тот же приём, что у Modal, но прижата к низу экрана и во всю
 * ширину. Нужна нижней навигации телефона — в ленту помещается пять пунктов,
 * а все разделы живут здесь (см. AppShell).
 *
 * Приём не придуман: вход — CSS-анимация .sheet-panel (как slide-up у
 * .modal-panel), выход — те же WAAPI-анимации и тот же таймер, что в Modal
 * (collapseOutKeyframes + гаснущая подложка, MODAL_EXIT_MS), плюс деградация
 * через resolveMotionPlan. Разметка — как у диалога: role="dialog",
 * aria-modal, заголовок, фокус внутрь и FocusTrap, Escape на десктопе.
 *
 * В стек оверлеев (hooks/useOverlayStack) шторка НЕ встаёт — намеренно. Её
 * единственный пользователь — «Ещё» в AppShell, а «Назад» с ней закрывает
 * backRouter.shell (см. комментарий про кнопку «Назад» в AppShell): роутер
 * отвечает РАНЬШЕ обработчика приложения. Запись в стеке была бы вторым
 * ответом на то же нажатие. Если роутер из AppShell уберут (см. его
 * комментарий) — достаточно добавить сюда `useOverlay(open, onClose)`.
 */
export function BottomSheet({
  open, onClose, title, children,
}: {
  open: boolean; onClose: () => void; title: string; children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLButtonElement>(null);
  const caps = useCapabilities();
  const titleId = useId();

  // Копия состояния и содержимого — как в Modal: окно живёт в DOM, пока идёт
  // выход, и не мигает пустым, если родитель уже закрыл его.
  const [mounted, setMounted] = useState(open);
  const lastChildren = useRef<ReactNode>(children);
  if (open) lastChildren.current = children;
  if (open && !mounted) setMounted(true);

  const exitRef = useRef<{ animations: Animation[]; timer: number | null }>({ animations: [], timer: null });
  const capsRef = useRef(caps);
  capsRef.current = caps;

  const stopExit = useCallback((): void => {
    for (const animation of exitRef.current.animations) animation.cancel();
    if (exitRef.current.timer !== null) window.clearTimeout(exitRef.current.timer);
    exitRef.current = { animations: [], timer: null };
  }, []);

  useEffect(() => stopExit, [stopExit]);

  useEffect(() => {
    if (open) {
      stopExit();
      return;
    }
    if (!mounted) return; // шторка уже размонтирована — выхода нечего играть
    const capsNow = capsRef.current;
    const prefs: MotionPreferences = { reduced: capsNow.reducedMotion, lowEnd: capsNow.lowEnd };
    const plan = resolveMotionPlan({ duration: MODAL_EXIT_MS, easing: EASE_OUT }, prefs);
    if (!plan.enabled) {
      setMounted(false);
      return;
    }
    const panel = panelRef.current;
    const overlay = overlayRef.current;
    const animations = [
      animate(overlay, [{ opacity: 1 }, { opacity: 0 }], {
        duration: plan.duration, easing: plan.easing, prefs,
      }),
      animate(panel, collapseOutKeyframes(10, 0.98), {
        duration: plan.duration, easing: plan.easing, prefs,
      }),
    ].filter((a): a is Animation => a !== null);
    exitRef.current = {
      animations,
      timer: window.setTimeout(() => {
        exitRef.current = { animations: [], timer: null };
        setMounted(false);
      }, plan.duration + EXIT_GRACE_MS),
    };
  }, [open, mounted, stopExit]);

  useEffect(() => {
    if (!open) return;
    // Фокус внутрь шторки: на кнопку закрытия. На телефоне фокус не виден,
    // но он нужен скринридеру и внешней клавиатуре на десктопе.
    const first = panelRef.current?.querySelector<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])');
    const focusTimer = first ? window.setTimeout(() => first.focus(), 100) : null;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      if (focusTimer !== null) window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open && !mounted) return null;
  const content = open ? children : lastChildren.current;

  return (
    <div
      // flex-col + justify-end: колонка тянется во всю ширину (align-items
      // по умолчанию stretch) и прижимается к низу. Именно так, а не
      // items-end, потому что панель лежит внутри FocusTrap, а он оборачивает
      // содержимое в свой div — как flex-элемент тот иначе сжался бы по
      // содержимому.
      className="fixed inset-0 z-50 flex flex-col justify-end"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      style={open ? undefined : { pointerEvents: "none" }}
    >
      <button
        ref={overlayRef}
        className="sheet-overlay absolute inset-0 cursor-default"
        onClick={onClose}
        aria-label="Закрыть"
        tabIndex={-1}
      />
      <FocusTrap active={open}>
        <div ref={panelRef} className="sheet-panel card relative w-full overflow-y-auto">
          <span className="sheet-grip" aria-hidden />
          <div className="flex items-center justify-between gap-4 px-4 pt-1 pb-3 border-b" style={{ borderColor: "var(--line)" }}>
            <h2 id={titleId} className="font-display text-sm tracking-[0.14em] uppercase" style={{ color: "var(--text)" }}>{title}</h2>
            <button className="btn-icon" onClick={onClose} aria-label="Закрыть список разделов"><X size={16} /></button>
          </div>
          <div className="px-3 pt-3 pb-3" style={{ paddingBottom: "max(12px, var(--sab))" }}>{content}</div>
        </div>
      </FocusTrap>
    </div>
  );
}

/**
 * Диалог подтверждения.
 *
 * `alternative` — второй вариант действия, когда «удалить» неоднозначно:
 * например, у регулярного платежа есть выбор «перенести на следующий месяц»
 * или «удалить совсем». Без него кнопка одна и поведение не менялось.
 */
export function ConfirmDialog({
  open, title, text, confirmLabel = "Да, удалить", onConfirm, onClose,
  alternative, hint,
}: {
  open: boolean; title: string; text: string; confirmLabel?: string;
  onConfirm: () => void; onClose: () => void;
  /** Второй вариант: подпись, действие и пояснение под ним. */
  alternative?: { label: string; hint?: string; onSelect: () => void };
  /** Пояснение под основной кнопкой — что именно будет удалено. */
  hint?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => {
        const confirmBtn = dialogRef.current?.querySelector('[data-confirm]');
        if (confirmBtn instanceof HTMLElement) {
          confirmBtn.focus();
        }
      }, 100);
    }
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div ref={dialogRef}>
        <p className="text-sm leading-relaxed" style={{ color: "var(--muted)" }}>{text}</p>
        {hint && (
          <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>{hint}</p>
        )}
        {alternative && (
          <div className="mt-4 p-3 rounded-lg" style={{ border: "1px solid var(--line)", background: "var(--card)" }}>
            <p className="text-xs mb-2.5" style={{ color: "var(--muted)" }}>{alternative.hint}</p>
            <button
              className="btn btn-ghost btn-sm w-full justify-center"
              onClick={() => { alternative.onSelect(); onClose(); }}
            >
              {alternative.label}
            </button>
          </div>
        )}
        <div className="mt-5 flex gap-3 justify-end">
          <button className="btn btn-ghost" onClick={onClose}>Отмена</button>
          <button
            className="btn btn-danger"
            style={{ color: "#ffffff" }}
            data-confirm
            onClick={() => { onConfirm(); onClose(); }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ─────────────────────────── Формы ─────────────────────────── */

export function Field({ label, children, error, hint }: { label: string; children: ReactNode; error?: string; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      {children}
      {error && <span className="block mt-1 text-xs" style={{ color: "var(--danger)" }}>{error}</span>}
      {!error && hint && <span className="block mt-1 text-xs" style={{ color: "var(--muted)" }}>{hint}</span>}
    </label>
  );
}

export function Segmented<T extends string>({
  options, value, onChange,
}: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const buttons = containerRef.current.querySelectorAll('[role="tab"]');
    buttons.forEach((btn, index) => {
      if (btn instanceof HTMLElement) {
        btn.setAttribute('tabindex', value === options[index].value ? '0' : '-1');
      }
    });
  }, [value, options]);

  const handleKeyDown = (e: KeyboardEvent, index: number) => {
    const buttons = containerRef.current?.querySelectorAll('[role="tab"]');
    if (!buttons) return;
    
    let newIndex = index;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      newIndex = (index + 1) % buttons.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      newIndex = (index - 1 + buttons.length) % buttons.length;
    } else if (e.key === 'Home') {
      e.preventDefault();
      newIndex = 0;
    } else if (e.key === 'End') {
      e.preventDefault();
      newIndex = buttons.length - 1;
    }
    
    if (newIndex !== index) {
      const newBtn = buttons[newIndex] as HTMLElement;
      newBtn.focus();
      onChange(options[newIndex].value);
    }
  };

  return (
    <div className="segmented" role="tablist" ref={containerRef}>
      {options.map((o, index) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          className={cn("segmented-btn", value === o.value && "segmented-btn-active")}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => handleKeyDown(e, index)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn("toggle", checked && "toggle-on")}
    >
      <span className="toggle-knob" />
    </button>
  );
}

export function ProgressBar({ pct, color, height = 8 }: { pct: number; color?: string; height?: number }) {
  const ratio = Math.min(1, Math.max(0, pct / 100));
  const ref = useRef<HTMLDivElement>(null);
  const caps = useCapabilities();
  // Предыдущая анимация: с fill: "both" она осталась бы в getAnimations()
  // и конфликтовала бы по каскаду со следующей (ТЗ п. 4.3).
  const animationRef = useRef<Animation | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    animationRef.current?.cancel();
    animationRef.current = null;
    // WAAPI: анимация идёт в потоке композитора и не трогает раскладку (ТЗ п. 4.2–4.3)
    // Уровень устройства доходит до анимации: на слабом устройстве и при
    // prefers-reduced-motion полоса сразу получает конечное значение.
    const animation = scaleProgress(el, ratio, 520, {
      reduced: caps.reducedMotion,
      lowEnd: caps.lowEnd,
    });
    animationRef.current = animation;
    return () => {
      animationRef.current?.cancel();
      animationRef.current = null;
    };
  }, [ratio, caps.reducedMotion, caps.lowEnd]);

  return (
    <div className="progress-track" style={{ height }}>
      <div
        ref={ref}
        className="progress-fill"
        style={{
          background: color ?? "var(--accent)",
          boxShadow: `0 0 10px color-mix(in srgb, ${color ?? "var(--accent)"} 55%, transparent)`,
        }}
      />
    </div>
  );
}

/* ─────────────────────────── Статусы и бейджи ─────────────────────────── */

export function StatusBadge({ status }: { status: TxStatus }) {
  if (status === "confirmed") {
    return (
      <span className="badge" style={{ color: "var(--ok)", borderColor: "color-mix(in srgb, var(--ok) 40%, transparent)", background: "color-mix(in srgb, var(--ok) 10%, transparent)" }}>
        <CheckCircle2 size={12} /> Подтверждён
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="badge" style={{ color: "var(--warn)", borderColor: "color-mix(in srgb, var(--warn) 40%, transparent)", background: "color-mix(in srgb, var(--warn) 10%, transparent)" }}>
        <Clock size={12} /> Ожидает
      </span>
    );
  }
  return (
    <span className="badge" style={{ color: "var(--muted)", borderColor: "var(--line)", background: "transparent" }}>
      <SkipForward size={12} /> Пропущен
    </span>
  );
}

/* ─────────────────────────── Пустые состояния ─────────────────────────── */

export function EmptyState({
  icon: Icon, title, text, action,
}: {
  icon: LucideIcon; title: string; text: string; action?: ReactNode;
}) {
  return (
    <div className="empty-state rise-in">
      <span className="hex hex-muted flex items-center justify-center" style={{ width: 64, height: 64, color: "var(--muted)" }}>
        <Icon size={26} strokeWidth={1.5} />
      </span>
      <h3 className="font-display text-sm uppercase tracking-[0.12em] mt-4" style={{ color: "var(--text)" }}>{title}</h3>
      <p className="text-sm mt-2 max-w-sm mx-auto" style={{ color: "var(--muted)" }}>{text}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/* ─────────────────────────── Заголовок страницы ─────────────────────────── */

export function PageHeader({ kicker, title, actions }: { kicker: string; title: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 mb-6 rise-in">
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <span className="kicker-tick" aria-hidden />
          <span className="text-[11px] font-semibold tracking-[0.22em] uppercase" style={{ color: "var(--accent)" }}>{kicker}</span>
        </div>
        <h1 className="font-display text-xl sm:text-2xl font-bold uppercase tracking-wide" style={{ color: "var(--text)" }}>{title}</h1>
      </div>
      {actions && <div className="flex flex-wrap gap-2.5">{actions}</div>}
    </div>
  );
}

/* ─────────────────────────── Тосты ─────────────────────────── */

/**
 * Схлопывание уходящего тоста. Высоту убираем CSS-переходом, потому что
 * WAAPI по ТЗ трогает только transform/opacity, а без плавного схлопывания
 * соседи по списку прыгали бы на высоту исчезающего тоста. Вызывается
 * после того, как тост уже погас (fade-out отработал), поэтому обрезанный
 * переход никто не видит — видно только плавное сдвигание соседей.
 * Сам список переходов задаёт style-проп тоста (transition у isLeaving).
 */
const collapseAway = (node: HTMLElement): void => {
  const view = node.ownerDocument?.defaultView;
  if (!view || typeof view.getComputedStyle !== "function") return;
  const height = node.getBoundingClientRect().height;
  const parent = node.parentElement;
  // Гап контейнера (flex gap) компенсируем отрицательным отступом: иначе
  // после удаления тоста соседи сдвинулись бы ещё на одну «пустую» строку.
  const gap = parent ? Number.parseFloat(view.getComputedStyle(parent).rowGap) || 0 : 0;
  node.style.overflow = "hidden";
  if (height > 0) {
    // Стартовое значение задаём явно: переход из `none` не интерполируется.
    // box-sizing: border-box (preflight Tailwind), поэтому это граница рамки.
    node.style.maxHeight = `${height}px`;
    // Принудительное чтение фиксирует стартовое значение — иначе браузер
    // успевает применить и его, и 0 в один кадр, и переход не начнётся.
    void node.offsetHeight;
  }
  node.style.maxHeight = "0px";
  node.style.paddingTop = "0px";
  node.style.paddingBottom = "0px";
  node.style.borderTopWidth = "0px";
  node.style.borderBottomWidth = "0px";
  node.style.marginBottom = `${-gap}px`;
  node.style.pointerEvents = "none";
};

export function ToastHost() {
  const { toasts, dismissToast } = useApp();
  const caps = useCapabilities();
  const listRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef<Set<string>>(new Set());
  /**
   * Собственный список тостов. AppProvider удаляет тост из контекста по своему
   * таймеру, и раньше он просто исчезал. Теперь контекст — только источник
   * «появился/уже не нужен», а рендерит список этот компонент: ушедший тост
   * остаётся в DOM, пока играет выход, и лишь затем вызывает dismissToast.
   */
  const [items, setItems] = useState<Toast[]>([]);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
  const nodesRef = useRef<Map<string, HTMLElement>>(new Map());
  const pendingRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Map<string, number>>(new Map());
  const aliveRef = useRef(true);
  // Рефы нужны, чтобы обработчики видели актуальные значения: колбэки ниже
  // создаются один раз, а список и настройки меняются каждый рендер.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;
  const capsRef = useRef(caps);
  capsRef.current = caps;

  // Отклик на нажатие живёт здесь: ToastHost смонтирован в App всегда.
  usePressFeedback();

  /** Тост доигран: убираем из списка и снимаем из контекста. */
  const finishLeave = useCallback((id: string): void => {
    if (!pendingRef.current.delete(id)) return; // уже обработан
    const timer = timersRef.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timersRef.current.delete(id);
    setLeaving((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setItems((prev) => prev.filter((t) => t.id !== id));
    // Снимаем тост из контекста, только если он там ещё есть. У истёкшего по
    // таймеру тоста AppProvider уже убрал его сам: лишний вызов создал бы
    // новый массив и перерендерил всё приложение вхолостую.
    if (toastsRef.current.some((t) => t.id === id)) dismissToast(id);
  }, [dismissToast]);

  /** Запустить уход: сначала гаснет и уезжает, затем схлопывается по высоте. */
  const startLeave = useCallback((id: string): void => {
    if (pendingRef.current.has(id)) return; // уже уходит
    pendingRef.current.add(id);
    setLeaving((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    const node = nodesRef.current.get(id) ?? null;
    const capsNow = capsRef.current;
    const prefs: MotionPreferences = { reduced: capsNow.reducedMotion, lowEnd: capsNow.lowEnd };
    const plan = resolveMotionPlan({ duration: TOAST_EXIT_MS, easing: EASE_OUT }, prefs);
    if (!plan.enabled) {
      // Деградация (ТЗ Группа 4): без анимации и без ожидания.
      finishLeave(id);
      return;
    }
    if (node) {
      // Стили, оставленные входом через applyFinal, убираем — иначе они
      // пережили бы уход и тост «залип» бы видимым.
      node.style.opacity = "";
      node.style.transform = "";
    }
    animate(node, fadeOutKeyframes(18), {
      duration: plan.duration,
      easing: plan.easing,
      prefs,
    });
    // Второй этап — по таймеру, а не по finished: так уход одинаков и на
    // движке, и в среде без WAAPI, и не зависит от того, долетел ли кадр.
    timersRef.current.set(id, window.setTimeout(() => {
      if (!aliveRef.current) return;
      const target = nodesRef.current.get(id) ?? null;
      if (target) collapseAway(target);
      timersRef.current.set(id, window.setTimeout(() => finishLeave(id), TOAST_COLLAPSE_MS + EXIT_GRACE_MS));
    }, plan.duration));
  }, [finishLeave]);

  /** Синхронизация с контекстом: новые — в список, исчезнувшие — в уход. */
  useEffect(() => {
    setItems((prev) => {
      const known = new Set(prev.map((t) => t.id));
      const added = toasts.filter((t) => !known.has(t.id));
      return added.length === 0 ? prev : [...prev, ...added];
    });
    const alive = new Set(toasts.map((t) => t.id));
    for (const t of itemsRef.current) {
      // Тост, которого больше нет в контексте, снят таймером AppProvider.
      if (!alive.has(t.id)) startLeave(t.id);
    }
  }, [toasts, startLeave]);

  // Таймеры уходящих тостов не должны трогать состояние после размонтирования.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      for (const timer of timersRef.current.values()) window.clearTimeout(timer);
      timersRef.current.clear();
      pendingRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const shown = shownRef.current;
    // Анимируем появление только новых тостов: уже показанные при добавлении
    // нового не должны «прыгать» заново (уходящие тоже: их id уже в shown).
    const fresh: HTMLElement[] = [];
    const nodes = Array.from(container.children);
    items.forEach((t, i) => {
      const node = nodes[i];
      if (!(node instanceof HTMLElement) || shown.has(t.id)) return;
      shown.add(t.id);
      fresh.push(node);
    });
    // Забываем id закрытых тостов, иначе набор растёт всю сессию.
    for (const id of shown) {
      if (!items.some((t) => t.id === id)) shown.delete(id);
    }
    if (fresh.length === 0) return;
    // ТЗ п. 4.3: одновременно анимируется не больше limit элементов.
    // На слабом устройстве и при prefers-reduced-motion элементы сразу видимы
    // (applyFinal), а не остаются в стартовом кадре.
    stagger(fresh, () => riseInKeyframes(10), {
      duration: 260,
      stepMs: 45,
      limit: 6,
      reduced: caps.reducedMotion,
      lowEnd: caps.lowEnd,
      applyFinal: (el): void => {
        el.style.opacity = "1";
        el.style.transform = "none";
      },
    });
  }, [items, caps.reducedMotion, caps.lowEnd]);

  return (
    <div ref={listRef} className="fixed bottom-4 right-4 z-[70] flex flex-col gap-2 w-[min(92vw,360px)]" aria-live="polite">
      {items.map((t) => {
        const color = t.kind === "success" ? "var(--ok)" : t.kind === "error" ? "var(--danger)" : "var(--accent)";
        const Icon = t.kind === "success" ? CheckCircle2 : t.kind === "error" ? X : Clock;
        const isLeaving = leaving.has(t.id);
        return (
          <div
            key={t.id}
            ref={(node) => {
              if (node) nodesRef.current.set(t.id, node);
              else nodesRef.current.delete(t.id);
            }}
            className="toast card"
            aria-hidden={isLeaving || undefined}
            style={{
              borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
              // Переход только у уходящего тоста: он схлопывается по высоте
              // (см. collapseAway). Остальным чужие CSS-переходы не трогаем.
              transition: isLeaving
                ? `max-height ${TOAST_COLLAPSE_MS}ms ease, padding ${TOAST_COLLAPSE_MS}ms ease, margin ${TOAST_COLLAPSE_MS}ms ease, border-width ${TOAST_COLLAPSE_MS}ms ease`
                : undefined,
              pointerEvents: isLeaving ? "none" : undefined,
            }}
          >
            <span style={{ color }} className="shrink-0 mt-0.5"><Icon size={16} /></span>
            <p className="text-sm flex-1 leading-snug" style={{ color: "var(--text)" }}>{t.text}</p>
            <button className="btn-icon shrink-0" onClick={() => startLeave(t.id)} aria-label="Скрыть уведомление"><X size={13} /></button>
          </div>
        );
      })}
    </div>
  );
}

/* ─────────────────────────── Анимация чисел ─────────────────────────── */

export function useAnimatedNumber(value: number, duration = 750): number {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  const caps = useCapabilities();

  useEffect(() => {
    const from = fromRef.current;
    fromRef.current = value;
    // На слабом устройстве или при «уменьшить движение» — сразу конечное значение (ТЗ Группа 4)
    if (caps.lowEnd || caps.reducedMotion) {
      setDisplay(value);
      return;
    }
    // Delta-time: длительность одинакова на 60 и 144 Гц (ТЗ п. 4.1)
    const ticker = createValueTransition({
      from,
      to: value,
      durationMs: duration,
      onUpdate: setDisplay,
    });
    ticker.start();
    return () => ticker.stop();
  }, [value, duration, caps.lowEnd, caps.reducedMotion]);

  return display;
}

/* ─────────────────────────── Поле файла ─────────────────────────── */

export function useFilePick(onFile: (file: File) => void) {
  const ref = useRef<HTMLInputElement>(null);
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) onFile(f);
    e.target.value = "";
  };
  const input = <input ref={ref} type="file" className="hidden" onChange={onChange} aria-hidden tabIndex={-1} />;
  const pick = () => ref.current?.click();
  return { input, pick };
}