// src/platform/webBridge.ts
// Базовый мост: всё через стандартные возможности браузера.
// Используется в веб-версии и как запасной путь в нативных оболочках.
import { APP_VERSION } from "../lib/constants";
import { RELEASES_PAGE_URL, type UpdateStatus, failedStatus } from "../lib/updater";
import type { PickedFile, PlatformBridge, PlatformFeatures, PlatformKind } from "./types";

const WEB_FEATURES: PlatformFeatures = {
  tray: false,
  nativeDialogs: false,
  notifications: true,
  backButton: false,
};

export const readTextFile = (accept = "application/json,.json"): Promise<PickedFile | null> =>
  new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        input.remove();
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        resolve({ name: file.name, text: String(reader.result ?? "") });
        input.remove();
      };
      reader.onerror = () => {
        resolve(null);
        input.remove();
      };
      reader.readAsText(file);
    });
    // Пользователь отменил выбор — событие не придёт, чистим по unload
    window.addEventListener("focus", () => {
      setTimeout(() => {
        if (document.body.contains(input)) resolve(null);
        input.remove();
      }, 400);
    }, { once: true });
    document.body.appendChild(input);
    input.click();
  });

export const downloadTextFile = (name: string, content: string): boolean => {
  try {
    const blob = new Blob([content], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  } catch {
    return false;
  }
};

export const createWebBridge = (kind: PlatformKind = "web"): PlatformBridge => ({
  kind,
  native: false,
  features: WEB_FEATURES,
  // Версия берётся из общей константы, а не из строки здесь: раньше в веб-режиме
  // показывалась «1.0.0» независимо от версии бандла, и настройки врали.
  appVersion: async () => APP_VERSION,
  storageHint: () => "indexeddb://nexus-finance/db.sqlite",
  openDataFolder: async () => false,
  pickTextFile: (accept) => readTextFile(accept),
  saveTextFile: async (name, content) => downloadTextFile(name, content),
  notify: async (title, body) => {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "granted") {
      new Notification(title, body ? { body } : undefined);
      return true;
    }
    if (Notification.permission === "default") {
      return (await Notification.requestPermission()) === "granted";
    }
    return false;
  },
  onBackButton: () => () => {
    /* аппаратной кнопки нет */
  },
  setTray: async () => false,

  /* ── Обновления в браузере неприменимы ──
   *
   * Страницу обновляет сам браузер, а не программа: «установить обновление»
   * здесь физически некуда. Поэтому пункт в настройках не ломается и не
   * изображает работу — он прямо говорит об этом и оставляет ссылку на
   * релиз. Реальная проверка версии здесь была бы враньём: сравнивать не с чем. */
  updates: "unsupported",
  checkForUpdates: async (): Promise<UpdateStatus> =>
    failedStatus(
      APP_VERSION,
      "unsupported",
      "В браузере обновление программы не выполняется: страницу обновляет сам браузер. Посмотреть список релизов можно по ссылке ниже.",
    ),
  downloadUpdate: async (): Promise<UpdateStatus> =>
    failedStatus(APP_VERSION, "unsupported", "Скачивать обновление здесь нечем: программа не установлена как отдельное приложение."),
  installUpdate: async () => false,
  openReleasesPage: async () => openReleasesInBrowser(RELEASES_PAGE_URL),
  onUpdateEvent: () => () => {
    /* событий нет: в браузере обновление не выполняется */
  },
});

/**
 * Открыть страницу релизов в браузере.
 *
 * В обычном браузере это единственный способ уйти наружу. `_blank` +
 * `noopener` обязательны: без `noopener` открытая страница получает ссылку на
 * наше окно (`window.opener`), а сама программа её использовать не умеет.
 */
export function openReleasesInBrowser(url: string): boolean {
  try {
    if (typeof window === "undefined") return false;
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    // Блокировщик всплывающих окон даёт null — это не поломка, но сказать
    // пользователю «открыто» было бы враньём.
    return opened !== null;
  } catch {
    return false;
  }
}
