// src/lib/electronApi.ts
//
// Контракт preload <-> renderer. Формы данных обязаны совпадать с тем, что
// отдаёт главный процесс (electron-main.cjs, раздел «Обновления»).
import type { UpdateStatus } from "./updater";

export interface ElectronAPI {
  openDataFolder: () => Promise<boolean>;
  /** Документ данных в JSON (совместимость со старыми версиями). */
  loadData?: () => Promise<unknown>;
  saveData?: (data: unknown) => Promise<boolean>;
  /** Файл SQLite: надёжное хранилище вместо WebView/localStorage. */
  loadDb?: () => Promise<string | null>;
  saveDb?: (base64: string) => Promise<boolean>;
  clearDb?: () => Promise<boolean>;
  /** Возможности платформы, которые даёт main-процесс (PlatformBridge). */
  appVersion?: () => Promise<string>;
  saveTextFile?: (name: string, content: string) => Promise<boolean>;
  pickTextFile?: (accept?: string) => Promise<{ name: string; text: string } | null>;
  notify?: (title: string, body?: string) => Promise<boolean>;
  setTray?: (visible: boolean) => Promise<boolean>;

  /* ── Обновления ──
   *
   * Все четыре метода вызывает только код кнопки в настройках: главный
   * процесс сам не проверяет наличие новой версии ни при старте, ни по
   * таймеру, ни при выходе. Методы необязательные — если preload старый
   * (или мост подменён веб-заглушкой), мост вернёт честный отказ, а не
   * упадёт на undefined.
   *
   * checkForUpdates/downloadUpdate -> UpdateStatus (см. src/lib/updater.ts)
   * installUpdate/openReleasesPage -> boolean
   * onUpdateStatus -> функция отписки от событий хода загрузки. */
  checkForUpdates?: () => Promise<UpdateStatus>;
  downloadUpdate?: () => Promise<UpdateStatus>;
  installUpdate?: () => Promise<boolean>;
  openReleasesPage?: () => Promise<boolean>;
  onUpdateStatus?: (handler: (status: UpdateStatus) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
