// src/animations/ticker.ts
// Delta-time цикл: скорость задаётся в единицах в секунду и не зависит
// от частоты кадров — на 144 Гц движение ровно такое же, как на 60 Гц
// (ТЗ п. 4.1). Чистые функции вынесены отдельно, чтобы тесты гоняли
// их без requestAnimationFrame.

/** Защита от «прыжка» после возврата на вкладку: кадр длиннее 100 мс режется. */
export const MAX_DELTA_MS = 100;

export interface TickerHost {
  now(): number;
  request(cb: (timestamp: number) => void): number;
  cancel(handle: number): void;
}

export const browserHost: TickerHost = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  request: (cb) => requestAnimationFrame(cb),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export interface Ticker {
  start(): void;
  stop(): void;
  readonly running: boolean;
}

export interface TickerSpec {
  /** Один шаг. Возвращает false — цикл завершается. */
  step: (deltaMs: number) => boolean;
  host?: TickerHost;
  maxDeltaMs?: number;
}

/** Единственный rAF-цикл на анимацию вместо отдельного на каждый компонент. */
export const createTicker = (spec: TickerSpec): Ticker => {
  const host = spec.host ?? browserHost;
  const maxDelta = spec.maxDeltaMs ?? MAX_DELTA_MS;
  let handle = 0;
  let last = 0;
  let running = false;

  const loop = (timestamp: number): void => {
    if (!running) return;
    if (!last) last = timestamp;
    const delta = Math.min(Math.max(timestamp - last, 0), maxDelta);
    last = timestamp;
    if (spec.step(delta)) handle = host.request(loop);
    else {
      running = false;
      handle = 0;
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      // Отсчёт с текущего момента, иначе первый кадр теряется
      last = host.now();
      handle = host.request(loop);
    },
    stop() {
      running = false;
      if (handle) host.cancel(handle);
      handle = 0;
    },
    get running() {
      return running;
    },
  };
};

export interface LinearMotion {
  value: number;
  elapsedMs: number;
}

/**
 * Чистый шаг равномерного движения.
 * ❌ x += 5               — скорость зависит от частоты кадров
 * ✅ x += speed * dt / 1000 — скорость в пикселях/секунду, dt в миллисекундах
 *
 * maxDeltaMs — лимит одного кадра. По умолчанию MAX_DELTA_MS; его можно
 * задать явно, чтобы шаг резал длинный кадр тем же порогом, что и
 * createTicker({ maxDeltaMs }) — иначе пользовательский лимит цикла
 * расходился с лимитом самого шага.
 */
export const stepLinear = (
  state: LinearMotion,
  deltaMs: number,
  speedPerSecond: number,
  maxDeltaMs: number = MAX_DELTA_MS,
): LinearMotion => {
  const dt = Math.min(Math.max(deltaMs, 0), maxDeltaMs);
  return { value: state.value + (speedPerSecond * dt) / 1000, elapsedMs: state.elapsedMs + dt };
};

export const easeOutCubic = (p: number): number => 1 - Math.pow(1 - clamp01(p), 3);
export const easeOutQuint = (p: number): number => 1 - Math.pow(1 - clamp01(p), 5);
export const clamp01 = (p: number): number => (p < 0 ? 0 : p > 1 ? 1 : p);

export interface ValueTransitionOptions {
  from: number;
  to: number;
  durationMs: number;
  ease?: (p: number) => number;
  onUpdate: (value: number) => void;
  onDone?: () => void;
  host?: TickerHost;
}

/**
 * Плавный переход значения по времени. На 60 и 144 Гц финиширует
 * через одинаковое wall-clock время и с одинаковым значением.
 */
export const createValueTransition = (options: ValueTransitionOptions): Ticker => {
  const ease = options.ease ?? easeOutCubic;
  const from = options.from;
  const delta = options.to - options.from;
  let elapsedMs = 0;

  return createTicker({
    ...(options.host ? { host: options.host } : {}),
    step: (dt) => {
      elapsedMs += dt;
      const progress = options.durationMs <= 0 ? 1 : clamp01(elapsedMs / options.durationMs);
      options.onUpdate(from + delta * ease(progress));
      if (progress >= 1) {
        options.onUpdate(options.to);
        options.onDone?.();
        return false;
      }
      return true;
    },
  });
};

/** Сколько «кадров» нужно на N миллисекунд при заданной частоте (для тестов/бенчмарков). */
export const framesFor = (durationMs: number, hz: number): number => {
  // Частоты 0 и ниже не бывает: без защиты вернулось бы Infinity.
  if (hz <= 0) return 0;
  return Math.round((durationMs / 1000) * hz);
};

/** Смещение, которое даст равномерное движение за durationMs. */
export const distanceFor = (durationMs: number, speedPerSecond: number): number =>
  speedPerSecond * (durationMs / 1000);
