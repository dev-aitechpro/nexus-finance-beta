// preload.cjs
// Мост renderer -> main. Выполняется в sandbox-контексте (sandbox: true),
// поэтому здесь доступны только require('electron') и несколько встроенных
// модулей песочницы (events, timers, url): fs, path и любая работа с файловой
// системой из preload недоступны. Всё, что нужно с диском, делает main-процесс.
//
// Наружу (contextBridge при contextIsolation: true) отдаём только
// window.electronAPI — набор функций. Модули, ipcRenderer и внутренние
// переменные наружу не выходят: в мире страницы их быть не должно.
//
// Имена каналов обязаны совпадать с ipcMain.handle в electron-main.cjs:
//   open-data-folder | load-db | save-db | clear-db | app-version |
//   save-text-file  | pick-text-file | notify | set-tray |
//   update:check    | update:download | update:install | update:open-releases
// Событие прогресса и смены этапа приходит по каналу 'update:status'.
//
// Формы данных — как в src/lib/electronApi.ts:
//   loadDb -> string|null, saveDb(base64) -> boolean, appVersion -> string,
//   saveTextFile(name, content) -> boolean,
//   pickTextFile -> {name, text}|null, notify(title, body?) -> boolean,
//   setTray(visible) -> boolean, openDataFolder -> boolean,
//   checkForUpdates/downloadUpdate -> UpdateStatus (src/lib/updater.ts),
//   installUpdate/openReleasesPage -> boolean,
//   onUpdateStatus(handler) -> функция отписки.
const { contextBridge, ipcRenderer } = require('electron');

/** Канал событий обновления: единственный, по нему идёт и прогресс, и этап. */
const UPDATE_STATUS_CHANNEL = 'update:status';

contextBridge.exposeInMainWorld('electronAPI', {
  // Открыть папку с данными в Проводнике (main отвечает true/false)
  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),

  // Файл SQLite (base64) — основное хранилище
  loadDb: () => ipcRenderer.invoke('load-db'),
  saveDb: (base64) => ipcRenderer.invoke('save-db', base64),
  clearDb: () => ipcRenderer.invoke('clear-db'),

  // ── Возможности платформы: 5 методов для PlatformBridge ──
  appVersion: () => ipcRenderer.invoke('app-version'),
  saveTextFile: (name, content) => ipcRenderer.invoke('save-text-file', name, content),
  // accept ("application/json,.json") пробрасываем в main: нативный диалог
  // показывает фильтр по расширениям, а не все файлы подряд.
  pickTextFile: (accept) => ipcRenderer.invoke('pick-text-file', accept),
  notify: (title, body) => ipcRenderer.invoke('notify', title, body),
  setTray: (visible) => ipcRenderer.invoke('set-tray', visible),

  // ── Обновления ──
  // Здесь нет ни одной подписки, которая сама что-то проверяет: каждый метод
  // ниже — прямой вызов главного процесса, и вызывает их только обработчик
  // кнопки в настройках. Событие update:status приходит лишь после того, как
  // пользователь уже нажал «Проверить обновления» или «Скачать».
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  // Ссылка наружу открывается в браузере ОС: главное окно запрещает и
  // window.open(), и уход на внешний адрес, поэтому из рендерера github.com
  // недостижим.
  openReleasesPage: () => ipcRenderer.invoke('update:open-releases'),
  onUpdateStatus: (handler) => {
    // Исключение обработчика не должно рвать подписку и глушить следующие
    // события: ловим, пишем в консоль (её дублирует главный процесс) и идём
    // дальше слушать.
    const listener = (_event, status) => {
      try {
        handler(status);
      } catch (error) {
        console.error('[preload] обработчик обновления бросил исключение:', error);
      }
    };
    ipcRenderer.on(UPDATE_STATUS_CHANNEL, listener);
    return () => ipcRenderer.removeListener(UPDATE_STATUS_CHANNEL, listener);
  },
});

// Строка в терминале: preload выполнился и window.electronAPI существует.
// Без неё «приложение открылось, но данные не те» приходится искать вслепую;
// дублируется в лог главного процесса обработчиком 'console-message'.
console.log('[preload] window.electronAPI готов (sandbox: true, contextIsolation: true)');
