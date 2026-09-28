// src/platform/capabilities.ts
// Определение возможностей устройства и стратегия деградации
// (ТЗ п. 5 «Оптимизация под слабые устройства», Группа 4).
//
// Правило: при RAM ≤ 2 ГБ отключаем необязательные анимации и визуальные
// эффекты (размытие, свечение), сокращаем число одновременных анимаций.

export type DeviceTier = "low" | "mid" | "high";

/** Границы из ТЗ: Android Go — RAM ≤ 2 ГБ. */
export const LOW_MEMORY_GB = 2;
export const MID_MEMORY_GB = 4;

export interface DeviceCapabilities {
  /** navigator.deviceMemory (Chrome/Edge). null, если браузер не сообщает. */
  deviceMemoryGb: number | null;
  hardwareConcurrency: number | null;
  /** Системная настройка «уменьшить движение». */
  reducedMotion: boolean;
  lowEnd: boolean;
  tier: DeviceTier;
  /** Почему выбран уровень — показываем в настройках. */
  reasons: string[];
  /** Ручное переопределение из настроек/URL. */
  override: "auto" | "low" | "high";
}

interface NavigatorHints extends Navigator {
  deviceMemory?: number;
}

const readOverride = (win: Window | undefined): DeviceCapabilities["override"] => {
  try {
    const search = win?.location?.search ?? "";
    if (/[?&]perf=low\b/.test(search)) return "low";
    if (/[?&]perf=high\b/.test(search)) return "high";
  } catch {
    /* не важно */
  }
  return "auto";
};

export const detectCapabilities = (
  win: Window | undefined = typeof window === "undefined" ? undefined : window,
): DeviceCapabilities => {
  const nav = win?.navigator as NavigatorHints | undefined;
  const memory = typeof nav?.deviceMemory === "number" ? nav.deviceMemory : null;
  const cores = typeof nav?.hardwareConcurrency === "number" ? nav.hardwareConcurrency : null;

  let reducedMotion = false;
  try {
    reducedMotion = !!win?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    reducedMotion = false;
  }

  const reasons: string[] = [];
  if (memory !== null && memory <= LOW_MEMORY_GB) reasons.push(`оперативная память ≈ ${memory} ГБ`);
  if (cores !== null && cores <= 2) reasons.push(`${cores} ядра CPU`);

  const lowEnd = reasons.length > 0;
  const tier: DeviceTier = lowEnd ? "low" : memory !== null && memory <= MID_MEMORY_GB ? "mid" : "high";
  const override = readOverride(win);

  return {
    deviceMemoryGb: memory,
    hardwareConcurrency: cores,
    reducedMotion,
    lowEnd: override === "low" ? true : override === "high" ? false : lowEnd,
    tier: override === "low" ? "low" : override === "high" ? "high" : tier,
    reasons,
    override,
  };
};

/** Различает CSS-анимации в зависимости от уровня устройства. */
export const applyCapabilities = (
  caps: DeviceCapabilities,
  root: HTMLElement | null = typeof document === "undefined" ? null : document.documentElement,
): void => {
  if (!root) return;
  root.dataset.perf = caps.tier;
  root.dataset.motion = caps.reducedMotion || caps.lowEnd ? "reduced" : "full";
  if (caps.reducedMotion) root.dataset.reducedMotion = "true";
  else delete root.dataset.reducedMotion;
};

/** Человеческое описание режима — для экрана настроек. */
export const describeTier = (caps: DeviceCapabilities): string => {
  if (caps.override !== "auto") return caps.override === "low" ? "Режим экономии (вручную)" : "Полные эффекты (вручную)";
  if (caps.lowEnd) return `Режим экономии: ${caps.reasons.join(", ")}`;
  if (caps.tier === "mid") return `Средний режим: память ≈ ${caps.deviceMemoryGb ?? "?"} ГБ`;
  return "Полные эффекты";
};
