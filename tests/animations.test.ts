// tests/animations.test.ts
// Группа 3/5 ТЗ: анимации не должны «плыть» на 144 Гц.
// Проверяем, что при эмуляции 60 и 144 Гц смещение за одно и то же
// wall-clock время совпадает (погрешность < 1%).
import { describe, expect, it } from "vitest";
import {
  MAX_DELTA_MS,
  browserHost,
  createTicker,
  createValueTransition,
  distanceFor,
  easeOutCubic,
  framesFor,
  stepLinear,
  type TickerHost,
} from "../src/animations/ticker";
import { resolveMotionPlan, stagger, type MotionPreferences } from "../src/animations/waapi";
import { detectCapabilities } from "../src/platform/capabilities";

/** Хост, имитирующий requestAnimationFrame с фиксированной частотой. */
const fakeHost = (hz: number): TickerHost & { flush: () => void } => {
  const frame = 1000 / hz;
  let nextHandle = 1;
  const queue = new Map<number, (t: number) => void>();
  let clock = 0;
  return {
    now: () => clock,
    request(cb) {
      const handle = nextHandle++;
      queue.set(handle, cb);
      return handle;
    },
    cancel(handle) {
      queue.delete(handle);
    },
    /** Прогнать все кадры, пока очередь не опустеет (с пределом). */
    flush() {
      let guard = 0;
      while (queue.size > 0 && guard < 100000) {
        guard++;
        const entries = [...queue.entries()];
        queue.clear();
        clock += frame;
        for (const [, cb] of entries) cb(clock);
      }
    },
  };
};

const FULL: MotionPreferences = { reduced: false, lowEnd: false };

describe("delta-time: независимость от частоты кадров", () => {
  it("смещение за 1 с одинаково на 60 и 144 Гц", () => {
    const speed = 300; // пикселей в секунду
    const duration = 1000;

    const run = (hz: number): number => {
      const host = fakeHost(hz);
      let value = 0;
      const ticker = createTicker({
        host,
        step: (dt) => {
          const next = stepLinear({ value, elapsedMs: 0 }, dt, speed);
          value = next.value;
          return value < speed;
        },
      });
      ticker.start();
      host.flush();
      return value;
    };

    const at60 = run(60);
    const at144 = run(144);
    const expected = distanceFor(duration, speed);
    expect(at60).toBeCloseTo(expected, 5);
    expect(at144).toBeCloseTo(expected, 5);
    // расхождение между частотами меньше 1%
    expect(Math.abs(at60 - at144) / expected).toBeLessThan(0.01);
  });

  it("фиксированное смещение за кадр, наоборот, разъезжается (регрессия)", () => {
    // Иллюстрация дефекта из ТЗ п. 1.3: x += 5 за кадр
    const perFrame = 5;
    const at60 = perFrame * framesFor(1000, 60);
    const at144 = perFrame * framesFor(1000, 144);
    expect(at144 / at60).toBeGreaterThan(2);
  });

  it("переход значения завершается за одинаковое wall-clock время", () => {
    const run = (hz: number): { elapsed: number; value: number } => {
      const host = fakeHost(hz);
      let value = 0;
      let elapsed = 0;
      const ticker = createValueTransition({
        from: 0,
        to: 1000,
        durationMs: 500,
        host,
        onUpdate: (v) => {
          value = v;
        },
      });
      ticker.start();
      const t0 = host.now();
      host.flush();
      elapsed = host.now() - t0;
      return { elapsed, value };
    };

    const a = run(60);
    const b = run(144);
    expect(a.value).toBeCloseTo(1000, 6);
    expect(b.value).toBeCloseTo(1000, 6);
    // 500 мс ± один кадр (+epsilon на округление): на 144 Гц кадр короче
    expect(Math.abs(a.elapsed - 500)).toBeLessThanOrEqual(1000 / 60 + 1e-6);
    expect(Math.abs(b.elapsed - 500)).toBeLessThanOrEqual(1000 / 144 + 1e-6);
  });

  it("длинный кадр (вкладка была свёрнута) ограничивается MAX_DELTA_MS", () => {
    const state = stepLinear({ value: 0, elapsedMs: 0 }, 5000, 1000);
    expect(state.elapsedMs).toBe(MAX_DELTA_MS);
    expect(state.value).toBeCloseTo(MAX_DELTA_MS, 6);
  });

  it("easing ограничен диапазоном [0, 1]", () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
    expect(easeOutCubic(0)).toBe(0);
  });

  it("ticker останавливается по требованию", () => {
    const host = fakeHost(60);
    const ticker = createTicker({ host, step: () => true });
    ticker.start();
    expect(ticker.running).toBe(true);
    ticker.stop();
    expect(ticker.running).toBe(false);
  });

  it("экспортирует браузерный host по умолчанию", () => {
    expect(typeof browserHost.request).toBe("function");
    expect(typeof browserHost.now()).toBe("number");
  });
});

describe("WAAPI: деградация анимаций", () => {
  it("на обычном устройстве анимация включена", () => {
    const plan = resolveMotionPlan({ duration: 320 }, FULL);
    expect(plan.enabled).toBe(true);
    expect(plan.duration).toBe(320);
  });

  it("на слабом устройстве анимация выключена", () => {
    const plan = resolveMotionPlan({ duration: 320 }, { reduced: false, lowEnd: true });
    expect(plan.enabled).toBe(false);
    expect(plan.duration).toBe(0);
  });

  it("при prefers-reduced-motion анимация выключена", () => {
    const plan = resolveMotionPlan({ duration: 320 }, { reduced: true, lowEnd: false });
    expect(plan.enabled).toBe(false);
  });

  it("stagger не превышает лимит одновременных анимаций", () => {
    const elements = Array.from({ length: 100 }, () => null);
    const animations = stagger(elements, () => [{ opacity: 0 }, { opacity: 1 }], { duration: 200, limit: 8 });
    expect(animations.length).toBe(0); // элементов нет — анимации не создаются
  });
});

describe("Определение возможностей устройства", () => {
  const fakeWindow = (opts: { memory?: number; cores?: number; reduced?: boolean; search?: string }) =>
    ({
      navigator: { deviceMemory: opts.memory, hardwareConcurrency: opts.cores },
      matchMedia: (query: string) => ({ matches: !!opts.reduced && query.includes("reduced-motion") }),
      location: { search: opts.search ?? "" },
      innerWidth: 1280,
    }) as unknown as Window;

  it("RAM ≤ 2 ГБ → режим экономии", () => {
    const caps = detectCapabilities(fakeWindow({ memory: 2, cores: 8 }));
    expect(caps.lowEnd).toBe(true);
    expect(caps.tier).toBe("low");
  });

  it("RAM 4 ГБ → средний режим, эффекты включены", () => {
    const caps = detectCapabilities(fakeWindow({ memory: 4, cores: 8 }));
    expect(caps.lowEnd).toBe(false);
    expect(caps.tier).toBe("mid");
  });

  it("8 ГБ и 8 ядер → полный режим", () => {
    const caps = detectCapabilities(fakeWindow({ memory: 8, cores: 8 }));
    expect(caps.tier).toBe("high");
    expect(caps.lowEnd).toBe(false);
  });

  it("2 ядра без данных о памяти → режим экономии", () => {
    const caps = detectCapabilities(fakeWindow({ cores: 2 }));
    expect(caps.lowEnd).toBe(true);
  });

  it("URL-параметр ?perf=low принудительно включает экономию", () => {
    const caps = detectCapabilities(fakeWindow({ memory: 8, cores: 16, search: "?perf=low" }));
    expect(caps.lowEnd).toBe(true);
    expect(caps.override).toBe("low");
  });
});
