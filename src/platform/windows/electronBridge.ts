// src/platform/windows/electronBridge.ts
// Мост Windows (Electron). Данные лежат файлом SQLite в userData,
// поэтому WebView/localStorage не участвуют в хранении (ТЗ п. 1.1).
//
// Нативные возможности (диалоги, уведомления, трей, версия приложения)
// берутся из main-процесса через preload. Если соответствующего IPC нет
// (старый preload, тестовая сборка) — прозрачный откат на веб-реализацию,
// чтобы мост никогда не бросал исключений.
import type { UpdateStatus } from "../../lib/updater";
import { createWebBridge, downloadTextFile, readTextFile } from "../webBridge";
import type { PickedFile, PlatformBridge, PlatformFeatures } from "../types";

const FEATURES: PlatformFeatures = {
  tray: true, // Tray в main-процессе
  nativeDialogs: true, // dialog.showSaveDialog / showOpenDialog
  notifications: true, // Notification в main-процессе
  backButton: false,
};

const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;

const api = (): Window["electronAPI"] | undefined =>
  typeof window === "undefined" ? undefined : window.electronAPI;

export const detectWindows = (): boolean =>
  typeof window !== "undefined" && window.electronAPI !== undefined && !/Android/i.test(ua);

export const createElectronBridge = (): PlatformBridge => {
  const web = createWebBridge("windows");
  return {
    kind: "windows",
    native: true,
    features: FEATURES,
    appVersion: async () => {
      const version = await api()?.appVersion?.();
      return version ?? web.appVersion();
    },
    storageHint: () => "Файл SQLite в папке данных приложения",
    openDataFolder: async () => {
      // main-процесс возвращает результат shell.openPath: папка могла не открыться.
      const open = api()?.openDataFolder;
      if (!open) return false;
      return open();
    },
    pickTextFile: async (accept): Promise<PickedFile | null> => {
      const nativePick = api()?.pickTextFile;
      // accept передаём дальше: без него нативный диалог показывает все файлы,
      // хотя вызывающий код просит конкретный тип.
      if (nativePick) return nativePick(accept);
      return readTextFile(accept);
    },
    saveTextFile: async (name, content) => {
      const nativeSave = api()?.saveTextFile;
      if (nativeSave) return nativeSave(name, content);
      return downloadTextFile(name, content);
    },
    notify: async (title, body) => {
      const nativeNotify = api()?.notify;
      if (nativeNotify) return nativeNotify(title, body);
      return web.notify(title, body);
    },
    onBackButton: () => () => {
      /* нет аппаратной кнопки */
    },
    setTray: async (visible) => {
      const setTray = api()?.setTray;
      if (!setTray) return false;
      return setTray(visible);
    },

    /* ── Обновления: всё делает главный процесс (electron-updater) ──
     *
     * Проверка, загрузка и установка выполняются в electron-main.cjs по
     * явному IPC — то есть только когда рендерер вызвал метод, а вызывает его
     * обработчик кнопки в настройках. Никаких подписок на «проверь при
     * старте» здесь нет и быть не должно.
     *
     * Если нужного IPC нет (старый preload, тестовая сборка), мост не падает
     * на undefined, а отдаёт честный отказ веб-реализации: «здесь
     * обновления не выполняются». */
    updates: "electron",
    checkForUpdates: async (): Promise<UpdateStatus> => {
      const check = api()?.checkForUpdates;
      return check ? check() : web.checkForUpdates();
    },
    downloadUpdate: async (): Promise<UpdateStatus> => {
      const download = api()?.downloadUpdate;
      return download ? download() : web.downloadUpdate();
    },
    installUpdate: async () => {
      const install = api()?.installUpdate;
      return install ? install() : web.installUpdate();
    },
    openReleasesPage: async () => {
      // Ссылку наружу открывает главный процесс через shell.openExternal:
      // главное окно запрещает и window.open(), и уход на внешний адрес
      // (см. createWindow в electron-main.cjs), поэтому из рендерера
      // github.com недостижим. Веб-заглушка — запасной путь.
      const open = api()?.openReleasesPage;
      return open ? open() : web.openReleasesPage();
    },
    onUpdateEvent: (handler) => {
      const subscribe = api()?.onUpdateStatus;
      return subscribe ? subscribe(handler) : () => undefined;
    },
  };
};
