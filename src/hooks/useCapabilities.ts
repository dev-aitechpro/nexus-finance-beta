// src/hooks/useCapabilities.ts
// React-обёртка над определением возможностей устройства:
// вычисляет один раз, слушает изменение prefers-reduced-motion,
// применяет data-perf/data-motion на <html> для CSS-деградации.
import { useEffect, useState } from "react";
import { applyCapabilities, detectCapabilities, type DeviceCapabilities } from "../platform/capabilities";

export const useCapabilities = (): DeviceCapabilities => {
  const [caps, setCaps] = useState<DeviceCapabilities>(() => detectCapabilities());

  useEffect(() => {
    const sync = () => setCaps(detectCapabilities());
    sync();
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    let query: MediaQueryList;
    try {
      query = window.matchMedia("(prefers-reduced-motion: reduce)");
    } catch {
      return;
    }
    const onChange = (): void => sync();
    if (typeof query.addEventListener === "function") query.addEventListener("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);

  useEffect(() => {
    applyCapabilities(caps);
  }, [caps]);

  return caps;
};
