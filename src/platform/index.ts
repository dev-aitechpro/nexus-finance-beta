// src/platform/index.ts
// Логика определения платформы и выбор моста (ТЗ Группа 2).
import { createAndroidBridge, detectAndroid } from "./android/capacitorBridge";
import type { PlatformBridge, PlatformKind } from "./types";
import { createWebBridge } from "./webBridge";
import { createElectronBridge, detectWindows } from "./windows/electronBridge";

export const detectPlatform = (): PlatformKind => {
  if (detectWindows()) return "windows";
  if (detectAndroid()) return "android";
  if (typeof navigator === "undefined") return "web";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Mac OS X/i.test(ua)) return "macos";
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux/i.test(ua)) return "linux";
  return "web";
};

let current: PlatformBridge | null = null;

/** Мост для текущей платформы (создаётся один раз). */
export const platform = (): PlatformBridge => {
  if (current) return current;
  const kind = detectPlatform();
  if (kind === "windows" && typeof window !== "undefined" && window.electronAPI) current = createElectronBridge();
  else if (kind === "android") current = createAndroidBridge();
  else current = createWebBridge(kind);
  return current;
};

export * from "./types";
export { describeTier, detectCapabilities, applyCapabilities } from "./capabilities";
export type { DeviceCapabilities, DeviceTier } from "./capabilities";
export { createWebBridge } from "./webBridge";
export { createElectronBridge, detectWindows } from "./windows/electronBridge";
export { createAndroidBridge, detectAndroid } from "./android/capacitorBridge";
