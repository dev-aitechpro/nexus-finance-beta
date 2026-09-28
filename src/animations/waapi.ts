// src/animations/waapi.ts
// Простые переходы — через Web Animations API: анимация идёт в потоке
// композитора и не блокирует главный поток даже на 144 Гц (ТЗ п. 4.3).
// Анимируются только transform/opacity — свойства раскладки не трогаем (ТЗ п. 4.2).
import type { DeviceTier } from "../platform/capabilities";

export const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
export const EASE_SPRING = "cubic-bezier(0.2, 0.9, 0.25, 1)";

export interface MotionPreferences {
  /** Системная настройка «уменьшить движение». */
  reduced: boolean;
  /** Слабое устройство: необязательные анимации отключаем. */
  lowEnd: boolean;
}

export interface MotionPlan {
  duration: number;
  easing: string;
  delay: number;
  /** false — анимацию не запускаем, значение применяется сразу. */
  enabled: boolean;
}

export interface MotionRequest {
  duration: number;
  easing?: string;
  delay?: number;
  tier?: DeviceTier;
  reduced?: boolean;
  /** Слабое устройство: перекрывает prefs.lowEnd, чтобы не забыть про ТЗ Группу 4. */
  lowEnd?: boolean;
  /**
   * Конечное состояние элемента на случай, когда анимацию отключила
   * деградация (слабое устройство / prefers-reduced-motion).
   * Без этого «выключить анимацию» означало бы «ничего не применить»:
   * элемент навсегда остался бы в стартовом состоянии. Для .progress-fill
   * стартовое состояние — scaleX(0), то есть у бюджета всегда были бы
   * ложные нули.
   */
  applyFinal?: (el: HTMLElement) => void;
}

/**
 * Правило деградации: на слабом устройстве или при prefers-reduced-motion
 * анимация выключается целиком (ТЗ п. 5, Группа 4).
 * Деградацию нельзя «отменить» конкретным запросом: lowEnd складывается
 * через ||, поэтому на слабом устройстве анимация останется выключенной.
 */
export const resolveMotionPlan = (request: MotionRequest, prefs: MotionPreferences): MotionPlan => {
  const reduced = request.reduced ?? prefs.reduced;
  const lowEnd = request.lowEnd === true || prefs.lowEnd;
  if (reduced || lowEnd) {
    return { duration: 0, easing: "linear", delay: 0, enabled: false };
  }
  return {
    duration: request.duration,
    easing: request.easing ?? EASE_OUT,
    delay: request.delay ?? 0,
    enabled: true,
  };
};

export const prefersReducedMotion = (): boolean => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

export interface AnimateOptions extends MotionRequest {
  prefs?: MotionPreferences;
  fill?: FillMode;
}

/**
 * Анимации, запущенные нами же на конкретном элементе.
 * Нужны, чтобы повторный запуск перезаписывал предыдущий: с fill: "both"
 * старая анимация навсегда остаётся в element.getAnimations(), конфликтует
 * по каскаду с новой и удерживает композитный слой (ТЗ п. 4.3).
 */
const ownAnimations = new WeakMap<Element, Set<Animation>>();

const cancelOwn = (element: Element): void => {
  const set = ownAnimations.get(element);
  if (!set) return;
  for (const animation of set) animation.cancel();
  set.clear();
};

const rememberOwn = (element: Element, animation: Animation): Animation => {
  const set = ownAnimations.get(element) ?? new Set<Animation>();
  set.add(animation);
  ownAnimations.set(element, set);
  return animation;
};

/**
 * Применить конечное состояние при отключённой анимации.
 * Проверка style — защита для сред без DOM (тесты гоняют чистые функции).
 */
const applyFinalState = (element: Element, applyFinal?: (el: HTMLElement) => void): void => {
  if (!applyFinal) return;
  const target = element as HTMLElement;
  if (typeof target.style !== "object") return;
  applyFinal(target);
};

/**
 * Запуск анимации с учётом деградации. Возвращает null, если анимация
 * отключена, но в этом случае обязательно применяется options.applyFinal:
 * «анимация выключена» ≠ «элемент остался в стартовом состоянии».
 *
 * Повторный вызов на том же элементе перезапускает анимацию — предыдущая
 * отменяется, иначе обе висели бы в getAnimations() и конфликтовали
 * по каскаду (ТЗ п. 4.3).
 */
export const animate = (
  element: Element | null | undefined,
  keyframes: Keyframe[],
  options: AnimateOptions,
): Animation | null => {
  if (!element || typeof element.animate !== "function") return null;
  const plan = resolveMotionPlan(options, options.prefs ?? { reduced: prefersReducedMotion(), lowEnd: false });
  // Снимаем прошлую анимацию и в обычном, и в деградированном случае:
  // с fill: "both" она держала бы элемент на промежуточном кадре вечно.
  cancelOwn(element);
  if (!plan.enabled || plan.duration <= 0) {
    applyFinalState(element, options.applyFinal);
    return null;
  }
  return rememberOwn(
    element,
    element.animate(keyframes, {
      duration: plan.duration,
      easing: plan.easing,
      delay: plan.delay,
      fill: options.fill ?? "both",
    }),
  );
};

/** Ключевые кадры появления снизу вверх — общие для riseIn и stagger. */
export const riseInKeyframes = (distance = 12): Keyframe[] => [
  { opacity: 0, transform: `translate3d(0, ${distance}px, 0)` },
  { opacity: 1, transform: "translate3d(0, 0, 0)" },
];

/**
 * Ключевые кадры ухода вбок — зеркало riseInKeyframes для исчезновения
 * (тосты, всплывающие панели). Только transform/opacity (ТЗ п. 4.2).
 */
export const fadeOutKeyframes = (distance = 16): Keyframe[] => [
  { opacity: 1, transform: "translate3d(0, 0, 0)" },
  { opacity: 0, transform: `translate3d(${distance}px, 0, 0)` },
];

/**
 * Ключевые кадры схлопывания окна: панель уходит вниз и гаснет.
 * Зеркало появлению slide-up из index.css, чтобы выход читался как
 * отмена входа, а не как исчезновение.
 */
export const collapseOutKeyframes = (distance = 10, scale = 0.98): Keyframe[] => [
  { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
  { opacity: 0, transform: `translate3d(0, ${distance}px, 0) scale(${scale})` },
];

/**
 * Где применять fadeIn: элементы, у которых в index.css нет своей CSS-анимации
 * появления, — например подложки и оверлеи. На элементе с готовым CSS-классом
 * (.rise-in, .view-anim, .toast, .modal-panel) вызывать fadeIn нельзя: две
 * анимации одного и того же свойства перекрывают друг друга по каскаду, и при
 * рассинхроне длительностей будет дёргаться. Для появления содержимого
 * (тело модального окна) — riseIn, для отклика на нажатие — pressPop.
 */
export const fadeIn = (el: Element | null, duration = 220, options: Partial<AnimateOptions> = {}): Animation | null =>
  animate(el, [{ opacity: 0 }, { opacity: 1 }], { duration, ...options });

/**
 * Где применять riseIn: содержимое, которое появляется внутри уже показанного
 * контейнера (тело модального окна в src/components/ui.tsx) — там, где у
 * контейнера своя CSS-анимация появления, а у содержимого её нет.
 * Для самого контейнера с классом .rise-in / .view-anim riseIn не нужен.
 *
 * С задержкой (delay > 0) обязательно передавайте fill: "backwards" — иначе
 * первый кадр не применится и элемент мигнёт: до старта он будет виден
 * в обычном состоянии, а потом прыгнет в opacity: 0.
 */
export const riseIn = (el: Element | null, distance = 12, duration = 320, options: Partial<AnimateOptions> = {}): Animation | null =>
  animate(el, riseInKeyframes(distance), { duration, ...options });

/**
 * Обратная связь на нажатие — только transform, без пересчёта раскладки.
 *
 * Вызывающий должен передавать fill: "none": с fill: "both" (значение по
 * умолчанию) конечный кадр scale(1) навсегда перекроет по каскаду CSS-состояния
 * элемента — подъём на hover (.cat-item, .theme-card, .cat-chip) и :active
 * у .btn перестанут работать. См. отклик в src/components/ui.tsx.
 */
export const pressPop = (el: Element | null, duration = 120, options: Partial<AnimateOptions> = {}): Animation | null =>
  animate(
    el,
    [{ transform: "scale(1)" }, { transform: "scale(0.97)" }, { transform: "scale(1)" }],
    { duration, easing: EASE_SPRING, ...options },
  );

/** Последнее значение полосы, которое мы сами записали в inline-стиль. */
const lastScaleX = (el: Element | null): string => {
  if (!el || typeof (el as HTMLElement).style !== "object") return "scaleX(0)";
  const inline = (el as HTMLElement).style.transform;
  return typeof inline === "string" && inline.startsWith("scaleX(") ? inline : "scaleX(0)";
};

/** Сдвиг прогресс-бара через scaleX: GPU-ускорено, в отличие от width. */
export const scaleProgress = (el: Element | null, ratio: number, duration = 420, options: Partial<AnimateOptions> = {}): Animation | null => {
  const clamped = Math.max(0, Math.min(1, ratio));
  const target = `scaleX(${clamped})`;
  // Откуда выросла полоса. Раньше «откуда» подставлялось неявно — по значению
  // предыдущей анимации, которую мы теперь отменяем. Без явного from полоса
  // стартовала бы заново от CSS-нуля (scaleX(0)) при каждом изменении.
  const from = lastScaleX(el);
  // Конечное значение пишем в inline-стиль сразу: оно останется верным и если
  // анимацию отключит деградация, и если её снимут, — в отличие от CSS-старта
  // scaleX(0), который давал бы ложные нули в бюджете.
  if (el && typeof (el as HTMLElement).style === "object") (el as HTMLElement).style.transform = target;
  return animate(el, [{ transform: from }, { transform: target }], {
    duration,
    easing: EASE_OUT,
    applyFinal: (node: HTMLElement): void => {
      node.style.transform = target;
    },
    ...options,
  });
};

/**
 * Очередь появления списков. Одновременно анимируется не больше limit
 * элементов — на слабых устройствах это снимает лаги (ТЗ п. 4.3).
 *
 * Поведение за пределом limit (сознательное, ТЗ п. 4.3):
 * — элементы с индексом < limit запускаются с задержкой i * stepMs;
 * — элементы с индексом >= limit не «пропадают»: они остаются в своём
 *   обычном состоянии. Ключевые кадры живут только внутри Animation и не
 *   пишутся в inline-стили, поэтому неанимированный элемент уже находится
 *   в конечном состоянии — длинный список целиком виден с первого кадра
 *   и не «мигает» пустыми строками;
 * — если вызывающий анимирует не от естественного состояния (как
 *   scaleProgress, чей CSS-старт scaleX(0)), он обязан передать
 *   applyFinal — он вызывается для элементов за лидерами и для каждого
 *   элемента, если анимации отключены деградацией.
 *
 * Повторный вызов на тех же элементах не копит анимации: animate()
 * отменяет то, что запустил раньше на этом же элементе.
 */
export const stagger = (
  elements: Array<Element | null>,
  build: (index: number) => Keyframe[],
  options: AnimateOptions & { stepMs?: number; limit?: number } = { duration: 260 },
): Animation[] => {
  const step = options.stepMs ?? 40;
  const limit = Math.max(1, options.limit ?? 24);
  const out: Animation[] = [];
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    if (!element) continue;
    if (i >= limit) {
      applyFinalState(element, options.applyFinal);
      continue;
    }
    const animation = animate(element, build(i), { ...options, delay: (options.delay ?? 0) + i * step });
    // Если анимация не создалась, animate() уже применил applyFinal —
    // элемент в конечном состоянии, а не в стартовом.
    if (animation) out.push(animation);
  }
  return out;
};
