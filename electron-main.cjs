// electron-main.cjs
// Главный процесс NEXUS Finance. Рендерер — собранный dist/index.html,
// открывается по file://; общение с ним только через preload.cjs
// (contextBridge -> window.electronAPI).
//
// Запуск из исходников (debug): npm run build && npx electron .
// Отладка включается только явно, обычный запуск её не включает:
//   npx electron . --dev      или      NEXUS_DEVTOOLS=1 npx electron .
const { app, BrowserWindow, ipcMain, shell, dialog, Notification, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');

/* ── Логи главного процесса ──
   При `npx electron .` терминал — единственное место, где видно, почему
   запуск не удался, поэтому всё важное уходит в stdout/stderr с префиксом.

   В СОБРАННОМ приложении окна консоли нет: electron.exe — GUI-сборка
   (PE Subsystem = 2, WINDOWS_GUI), и запускается он напрямую, без npm/cmd.
   Консольный вывод в этом случае просто исчезает: у процесса нет
   подключённой консоли, а stdout никто не читает. Поэтому дополнительно
   пишем те же строки в файл в папке журналов пользователя — иначе в релизной
   сборке при падении не остаётся вообще никаких следов. */

const LOG_LIMIT = 2 * 1024 * 1024; // 2 МБ: дальше.oldlog откладывается
let logHandle = null;
let logPath = null;

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** Открыть файл журнала (папка логов пользователя). Ошибки не мешают работе. */
const openLogFile = () => {
  if (logHandle !== null) return;
  try {
    const dir = app.getPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, 'nexus-finance.log');
    try {
      // Не даём журналу расти бесконечно: один предыдущий файл оставляем.
      if (fs.statSync(logPath).size > LOG_LIMIT) fs.renameSync(logPath, `${logPath}.old`);
    } catch {
      /* файла ещё нет — это нормально */
    }
    logHandle = fs.openSync(logPath, 'a');
  } catch (error) {
    logHandle = null;
    logPath = null;
    console.error('[main] не удалось открыть файл журнала:', error?.message ?? error);
  }
};

const toFile = (level, args) => {
  if (logHandle === null) return;
  try {
    fs.writeSync(logHandle, `[${stamp()}] ${level} ${args.map((a) => (a instanceof Error ? a.stack ?? a.message : String(a))).join(' ')}\n`);
  } catch {
    /* диск кончился или файл удалили — молча продолжаем работать */
  }
};

const log = (...args) => { console.log('[main]', ...args); toFile('[main]', args); };
const warn = (...args) => { console.warn('[main]', ...args); toFile('[main] !', args); };
const fail = (...args) => { console.error('[main]', ...args); toFile('[main] !!', args); };

/** Отладочный режим: только по явному флагу/переменной, никогда при старте. */
const DEBUG = process.argv.includes('--dev') || process.env.NEXUS_DEVTOOLS === '1';

const APP_DIR = __dirname;
const DIST_ENTRY = path.join(APP_DIR, 'dist', 'index.html');
const ICON_PATH = path.join(APP_DIR, 'public', 'favicon.ico');
const PRELOAD_PATH = path.join(APP_DIR, 'preload.cjs');
const BUILD_HINT = 'dist/index.html не найден — выполните `npm run build` и запустите electron . снова';

/** Главное окно: нужно трею и нативным диалогам. Иконка в трее: создаётся
 *  по запросу рендера и не блокирует выход приложения. */
let mainWindow = null;
let tray = null;
/** Ссылка на показываемое уведомление: без неё сборщик мусора может убить
 *  Notification раньше, чем она появится. */
let notification = null;

/** Внутренний адрес — файл внутри каталога приложения (dist/, public/). */
const isInternalUrl = (url) => {
  if (typeof url !== 'string' || !url.startsWith('file://')) return false;
  try {
    const relative = path.relative(APP_DIR, fileURLToPath(url));
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
};

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

/** Показать ошибку старта прямо в окне. data:-URL Electron не грузит, поэтому
 *  страницу пишем во временный каталог и открываем через loadFile. */
const showStartupError = (win, title, details) => {
  const page = [
    '<!doctype html><html lang="ru"><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>body{font:14px/1.6 system-ui,sans-serif;margin:0;padding:32px;background:#0d1117;color:#e6edf3}',
    'h1{font-size:18px;margin:0 0 12px}p{white-space:pre-wrap;margin:0}</style>',
    `</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(details)}</p></body></html>`,
  ].join('');
  const file = path.join(app.getPath('temp'), 'nexus-finance-startup-error.html');
  try {
    fs.writeFileSync(file, page, 'utf-8');
    win.loadFile(file).catch((error) => fail('не удалось показать страницу с ошибкой:', error?.message ?? error));
  } catch (error) {
    fail('не удалось записать страницу с ошибкой:', error?.message ?? error);
  }
};

/* ── Файловое хранилище SQLite рядом с данными приложения ── */

const getDbPath = () => path.join(app.getPath('userData'), 'nexus-data.sqlite');

/** Сбросить каталог на диск. На Windows каталоги не открываются — ошибка игнорируется. */
const syncDir = (dirPath) => {
  let fd = null;
  try {
    fd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(fd);
  } catch {
    /* Windows/POSIX могут не поддержать fsync каталога — это не критично */
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* уже закрыт */
      }
    }
  }
};

ipcMain.handle('load-db', async () => {
  // null — базы ещё нет (первый запуск), исключение — база есть, но не
  // читается. Эти случаи нельзя смешивать: иначе ElectronSnapshotStore
  // решит, что данных нет, и автосохранение затрёт файл (см. src/storage).
  let dbPath = null;
  try {
    dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) return null;
    return fs.readFileSync(dbPath).toString('base64');
  } catch (error) {
    fail(`не удалось прочитать файл базы ${dbPath ?? '(путь неизвестен)'}: ${error?.message ?? error} — данные не перезаписываются`);
    throw error;
  }
});

ipcMain.handle('save-db', async (event, base64) => {
  let tmpPath = null;
  let fd = null;
  let dbPath = null;
  try {
    dbPath = getDbPath();
    if (typeof base64 !== 'string' || !base64) return false;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    // Атомарная запись: временный файл + переименование
    tmpPath = `${dbPath}.tmp`;
    const buffer = Buffer.from(base64, 'base64');
    fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, buffer);
    // fsync до rename: при потере питания не остаётся обрезанный образ БД
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, dbPath);
    tmpPath = null;
    syncDir(path.dirname(dbPath));
    return true;
  } catch (error) {
    // Рендерер по false покажет «не смог записать файл базы» — сначала скажем почему.
    fail(`не удалось сохранить файл базы ${dbPath ?? '(путь неизвестен)'}: ${error?.message ?? error}`);
    if (tmpPath) fs.rmSync(tmpPath, { force: true });
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* уже закрыт */
      }
    }
  }
});

ipcMain.handle('clear-db', async () => {
  let dbPath = null;
  try {
    dbPath = getDbPath();
    if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
    log('файл базы удалён:', dbPath);
    return true;
  } catch (error) {
    fail(`не удалось удалить файл базы ${dbPath ?? '(путь неизвестен)'}: ${error?.message ?? error}`);
    return false;
  }
});

ipcMain.handle('open-data-folder', async () => {
  try {
    // shell.openPath возвращает строку с ошибкой при неудаче и '' при успехе
    const error = await shell.openPath(app.getPath('userData'));
    if (error) {
      warn('не удалось открыть папку с данными:', error);
      return false;
    }
    return true;
  } catch (error) {
    fail('не удалось открыть папку с данными:', error?.message ?? error);
    return false;
  }
});

/* ── Возможности платформы для PlatformBridge (ТЗ Группа 2) ── */

const activeWindow = () => BrowserWindow.getFocusedWindow() ?? mainWindow ?? null;

ipcMain.handle('app-version', async () => app.getVersion());

ipcMain.handle('save-text-file', async (event, name, content) => {
  let filePath = null;
  try {
    const win = activeWindow();
    const result = await dialog.showSaveDialog(win ?? undefined, {
      title: 'Сохранить файл',
      defaultPath: name || 'backup.json',
      filters: [{ name: 'Данные NEXUS', extensions: ['json'] }],
    });
    // Отмена и ошибка записи для рендерера выглядят одинаково (false) — это
    // ограничение типа Promise<boolean>, правится только в src.
    if (result.canceled || !result.filePath) return false;
    filePath = result.filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, String(content ?? ''), 'utf-8');
    log('файл сохранён:', filePath);
    return true;
  } catch (error) {
    fail(`не удалось записать файл ${filePath ?? '(не выбран)'}: ${error?.message ?? error}`);
    return false;
  }
});

// Строка accept из рендерера ("application/json,.json") превращается в
// расширения для нативного дилога. Берём часть после последней запятой —
// это и есть расширения; MIME-типы до запятой диалогу не нужны.
// Если формат неожиданный, показываем все файлы, а не пустой фильтр.
const extensionsFromAccept = (accept) => {
  const raw = String(accept ?? '');
  const tail = raw.includes(',') ? raw.slice(raw.lastIndexOf(',') + 1) : raw;
  return [...new Set(
    tail
      .split(',')
      .map((part) => part.trim().replace(/^\./, ''))
      .filter((part) => /^[a-z0-9]+$/i.test(part)),
  )];
};

ipcMain.handle('pick-text-file', async (_event, accept) => {
  try {
    const exts = extensionsFromAccept(accept);
    const win = activeWindow();
    const result = await dialog.showOpenDialog(win ?? undefined, {
      title: 'Выбрать файл с данными',
      properties: ['openFile'],
      filters: exts.length
        ? [{ name: 'Данные NEXUS', extensions: exts }]
        : [{ name: 'Все файлы', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePaths?.length) return null;
    const filePath = result.filePaths[0];
    const text = fs.readFileSync(filePath, 'utf-8');
    log('файл прочитан:', filePath);
    return { name: path.basename(filePath), text };
  } catch (error) {
    // null рендерер читает как «пользователь отменил выбор» и молчит, поэтому
    // о нечитаемом файле сообщаем здесь и пробрасываем ошибку наверх.
    fail(`не удалось прочитать выбранный файл: ${error?.message ?? error}`);
    throw error;
  }
});

ipcMain.handle('notify', async (event, title, body) => {
  try {
    if (!Notification.isSupported()) {
      warn('системные уведомления не поддерживаются — уведомление не показано');
      return false;
    }
    notification = new Notification({ title: String(title ?? ''), body: body ? String(body) : undefined });
    notification.on('close', () => {
      notification = null;
    });
    notification.show();
    return true;
  } catch (error) {
    fail('не удалось показать уведомление:', error?.message ?? error);
    return false;
  }
});

/* ── Обновления приложения ────────────────────────────────────────────────────
 *
 * ЖЁСТКОЕ ПРАВИЛО ЭТОГО БЛОКА: обновление происходит только по явному
 * нажатию кнопки в настройках. Ни при старте, ни по таймеру, ни при фокусе
 * окна, ни при выходе из программы проверки и загрузки не происходит.
 *
 * Что это значит технически:
 *   • autoDownload = false            — файл качает только кнопка «Скачать»;
 *   • autoInstallOnAppQuit = false    — закрытие окна НЕ ставит обновление;
 *   • checkForUpdates() вызывается ровно из одного места — обработчика
 *     'update:check', то есть только из нажатия кнопки. Ниже нет ни одного
 *     setInterval / setTimeout, который дёргал бы обновлятор;
 *   • в before-quit (см. конец файла) установка тоже не вызывается.
 * Это осознанно, а не «не успели»: пользователь сам решает, когда менять
 * программу, и никто не переносит его на новую версию за спиной.
 *
 * Механику берём из electron-updater, а не пишем свой загрузчик: он умеет
 * докачивать файл частями по blockmap, сверять размер и sha512 и запускать
 * NSIS-установщик. */

/** Куда смотрим за обновлениями и куда отправляем пользователя вручную. */
const UPDATE_REPO = {
  owner: 'dev-aitechpro',
  repo: 'nexus-finance-beta',
  releasesUrl: 'https://github.com/dev-aitechpro/nexus-finance-beta/releases/latest',
};

/** Экземпляр обновлятора. Создаётся лениво и только по кнопке. */
let autoUpdater = null;
/** Ошибка загрузки самого модуля: показать её один раз честно, а не падать. */
let autoUpdaterLoadError = null;
/** Найдена новая версия и у обновлятеля есть данные о ней (можно качать). */
let updateInfoReady = false;

/**
 * Текущее состояние — единственный источник правды для рендера.
 *
 * Один объект на все ответы и все события намеренно: если этап выставлять и
 * по событию electron-updater, и по результату checkForUpdates, два источника
 * будут перетирать друг друга, и интерфейс покажет «скачано» там, где загрузки
 * не было.
 */
const updateState = {
  phase: 'idle',
  currentVersion: '',
  availableVersion: null,
  message: 'Обновление ещё не проверялось. Нажмите «Проверить обновления».',
  needsAccess: false,
  signatureUnverified: false,
  releaseNotes: null,
  progress: null,
  checkedAt: null,
};

/** Снимок состояния для IPC: наружу не отдаём внутренние ссылки. */
const updateSnapshot = () => ({
  ...updateState,
  mode: 'electron',
  releaseUrl: UPDATE_REPO.releasesUrl,
});

/** Разослать состояние всем окнам (окно одно, но список окон — правильный). */
const sendUpdateStatus = (payload) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('update:status', payload);
    } catch (error) {
      warn('не удалось отправить состояние обновления в окно:', error?.message ?? error);
    }
  }
  log(`обновления: ${payload.phase}${payload.availableVersion ? ` → ${payload.availableVersion}` : ''} — ${payload.message}`);
};

/** Записать новое состояние, разослать его и вернуть снимок для ответа IPC. */
const setUpdateState = (patch) => {
  Object.assign(updateState, patch);
  const payload = updateSnapshot();
  sendUpdateStatus(payload);
  return payload;
};

/**
 * Что лежит в app-update.yml рядом с exe.
 *
 * Этот файл пишет electron-builder из build.publish в package.json, и
 * electron-updater берёт репозиторий ИМЕННО ИЗ НЕГО — не отсюда. Поэтому файл
 * читается для двух вещей:
 *   1) проверка подписи: NsisUpdater.verifySignature() (node_modules/
 *      electron-updater/out/NsisUpdater.js, строки 84-100) берёт отсюда
 *      publisherName и, если поля нет, возвращает null — то есть проверка
 *      молча пропускается, ошибки не будет. Сборка у нас не подписана, поля
 *      нет (проверено на реальной сборке: в файле только owner, repo,
 *      provider и updaterCacheDirName), и «проверка подписи» не произойдёт
 *      НИКОГДА. Значит, сказать пользователю «подпись проверено» нельзя даже
 *      теоретически — и мы говорим об этом прямо, вместо зелёного «готово»;
 *   2) сверка репозитория: если в файле чужой owner/repo, обновление пойдёт
 *      не туда, и объяснить пользователю это должна сборка, а не он.
 *
 * Разбираем регуляркой, без yaml-зависимости: в собранном приложении
 * node_modules рядом может не оказаться (см. build.files), и require('js-yaml')
 * тогда упал бы вместо понятного сообщения.
 */
const yamlScalar = (text, key) => {
  const match = new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*(.+)$`, 'm').exec(text);
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
};

const updateConfigInfo = () => {
  const file = path.join(process.resourcesPath || '', 'app-update.yml');
  let text;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return { configFound: false, publisher: null, owner: null, repo: null, channel: null };
  }
  return {
    configFound: true,
    publisher: yamlScalar(text, 'publisherName'),
    owner: yamlScalar(text, 'owner'),
    repo: yamlScalar(text, 'repo'),
    channel: yamlScalar(text, 'channel'),
  };
};

/** Проверяет, будет ли вообще проверена подпись установщика. */
const signatureInfo = () => {
  const info = updateConfigInfo();
  return { checked: Boolean(info.publisher), publisher: info.publisher, configFound: info.configFound };
};

/** Заметки к релизу у electron-updater бывают строкой или списком — приводим к строке. */
const releaseNotesText = (notes) => {
  if (typeof notes === 'string') return notes.trim() || null;
  if (Array.isArray(notes)) {
    const text = notes
      .map((item) => `v${item?.version ?? ''}: ${item?.note ?? ''}`.trim())
      .filter(Boolean)
      .join('\n\n');
    return text || null;
  }
  return null;
};

/**
 * Загрузить electron-updater и выставить настройки осознанно.
 *
 * Модуль грузится лениво (require внутри функции), и ошибка загрузки не
 * поднимает приложение: в собранной сборке node_modules может не оказаться
 * рядом, и тогда пункт настроек должен честно сказать «автообновление не
 * настроено», а не ронять программу.
 */
const getAutoUpdater = () => {
  if (autoUpdater !== null || autoUpdaterLoadError !== null) return autoUpdater;
  try {
    // eslint-disable-next-line global-require
    const { autoUpdater: updater } = require('electron-updater');

    /* electron-updater сам о молчаливом пишет в stdout, а в собранном
       приложении консоли нет — привязываем его к нашему журналу. */
    updater.logger = {
      info: (message) => log('electron-updater:', message),
      warn: (message) => warn('electron-updater:', message),
      error: (message) => fail('electron-updater:', message),
    };

    // Каждая строка ниже — часть требования «только по решению пользователя».
    updater.autoDownload = false;          // файл качает только кнопка «Скачать»
    updater.autoInstallOnAppQuit = false;  // выход из программы ничего не ставит
    updater.autoRunAppAfterInstall = true; // после установки программа запустится снова
    // Версия сборки — пререлизная (1.0.0-beta.N), поэтому ищем и пререлизы:
    // иначе electron-updater смотрел бы только на «последний стабильный».
    updater.allowPrerelease = true;
    // Откат на более старую версию не предлагаем: allowPrerelease в документации
    // упоминаетallowDowngrade, а в коде он не выставляется, поэтому задаём явно.
    updater.allowDowngrade = false;
    // Сборка nsis, а не веб-установщик: без этого флага пакет ругается
    // предупреждением на каждую загрузку (NsisUpdater.js, строки 44-46).
    updater.disableWebInstaller = true;

    updater.on('error', (error, message) => {
      // Подробности уже разбирает describeUpdateFailure; здесь только след.
      fail('electron-updater сообщил об ошибке:', message ?? error?.message ?? error);
    });
    updater.on('checking-for-update', () => log('electron-updater: проверка по нажатию кнопки'));
    updater.on('update-available', (info) => log('electron-updater: найдена версия', info?.version));
    updater.on('update-not-available', (info) => log('electron-updater: обновлений нет, на сервере', info?.version));
    updater.on('update-cancelled', (info) => warn('electron-updater: загрузка отменена, версия', info?.version));
    updater.on('download-progress', (progress) => {
      setUpdateState({
        phase: 'downloading',
        progress: {
          percent: Math.round(progress?.percent ?? 0),
          transferred: progress?.transferred ?? 0,
          total: progress?.total ?? 0,
          bytesPerSecond: progress?.bytesPerSecond ?? 0,
        },
      });
    });
    updater.on('update-downloaded', (event) => {
      const signature = signatureInfo();
      setUpdateState({
        phase: 'downloaded',
        progress: null,
        availableVersion: event?.version ?? updateState.availableVersion,
        signatureUnverified: !signature.checked,
        message: signature.checked
          ? `Файл версии ${event?.version ?? ''} скачан и подписан издателем. Можно устанавливать.`
          : `Файл версии ${event?.version ?? ''} скачан, но подпись сборки не подтверждена: установщик не подписан, и electron-updater такую проверку пропускает. Устанавливайте только если доверяете источнику — страница релиза на GitHub.`,
      });
    });

    autoUpdater = updater;
    log('electron-updater загружен: autoDownload=false, autoInstallOnAppQuit=false, allowPrerelease=true');
  } catch (error) {
    autoUpdaterLoadError = error;
    fail('не удалось загрузить electron-updater:', error?.message ?? error);
  }
  return autoUpdater;
};

/**
 * Из ошибки обновлятеля — честное сообщение для пользователя.
 *
 * Главный случай — закрытый репозиторий. GitHub анонимному запросу отдаёт на
 * закрытый репозиторий 404 (скрывая сам факт приватности) или 403, а
 * electron-updater заворачивает это в ERR_UPDATER_LATEST_VERSION_NOT_FOUND
 * (providers/GitHubProvider.js, строки 158-175) либо в
 * ERR_UPDATER_CHANNEL_FILE_NOT_FOUND, и по тексту «приватность» не читается.
 * Различаем по кодам в тексте ошибки.
 *
 * Отдельно: 404 в поле ENOENT — это не GitHub, а отсутствие app-update.yml
 * рядом с exe. Сборка без настройки публикации выглядит снаружи так же, но
 * причина и подсказка другие.
 */
const describeUpdateFailure = (error, action) => {
  const text = String(error?.message ?? error ?? 'причина неизвестна');
  const whole = `${text}\n${error?.code ?? ''}\n${error?.stack ?? ''}`;

  if (error?.code === 'ENOENT' || /app-update\.yml/i.test(whole)) {
    return setUpdateState({
      phase: 'failed',
      needsAccess: false,
      progress: null,
      message: 'В этой сборке нет файла app-update.yml — она собрана без настройки публикации на GitHub, поэтому автоматическое обновление не настроено. Скачать новую версию можно со страницы релиза.',
    });
  }

  if (/\b(401|403|404)\b/.test(whole) || /Unable to find latest version on GitHub/.test(whole)) {
    updateInfoReady = false;
    return setUpdateState({
      phase: 'access-denied',
      needsAccess: true,
      progress: null,
      message: 'GitHub не отдал данные о релизе: репозиторий закрыт, а программа ходит в него без входа в учётную запись. Токен внутрь приложения не вшивается намеренно — иначе он лежал бы у всех пользователей. Откройте страницу релиза в браузере: скорее всего, вы уже вошли в GitHub под своей учёткой.',
    });
  }

  return setUpdateState({
    phase: 'failed',
    needsAccess: false,
    progress: null,
    message: `${action} не удалось: ${text}`,
  });
};

/* Проверка наличия обновления. Единственный вызов checkForUpdates() во всём
   файле — здесь, и сюда попадает только нажатие кнопки в настройках. */
ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) {
    return setUpdateState({
      phase: 'unsupported',
      needsAccess: false,
      progress: null,
      message: 'Приложение запущено из исходников, а не из установленной сборки: проверять обновления здесь нечего. Собранная версия обновляется обычным образом.',
    });
  }
  if (updateState.phase === 'checking') return updateSnapshot();
  if (updateState.phase === 'downloading') {
    return setUpdateState({ message: 'Обновление уже скачивается — дождитесь окончания загрузки.' });
  }

  const updater = getAutoUpdater();
  if (!updater) {
    return setUpdateState({
      phase: 'failed',
      needsAccess: false,
      progress: null,
      message: `Модуль обновления не загрузился: ${autoUpdaterLoadError?.message ?? autoUpdaterLoadError}. Скачать новую версию можно со страницы релиза.`,
    });
  }

  // Страховка от «кто-то где-то сбросил флаг»: обе настройки обязаны стоять
  // перед каждой проверкой, а не только при первой загрузке модуля.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;

  updateInfoReady = false;
  setUpdateState({
    phase: 'checking',
    needsAccess: false,
    progress: null,
    message: 'Проверяю наличие новой версии…',
  });

  try {
    const result = await updater.checkForUpdates();
    if (result === null || result === undefined) {
      // isUpdaterActive() === false: обновлятор отключён, а не «новых версий нет».
      return setUpdateState({
        phase: 'unsupported',
        message: 'Обновлятор в этой сборке отключён: автоматическая проверка не выполняется. Скачать новую версию можно со страницы релиза.',
      });
    }
    const version = result.updateInfo?.version ?? null;
    const notes = releaseNotesText(result.updateInfo?.releaseNotes) ?? releaseNotesText(result.updateInfo?.releaseName);
    if (result.isUpdateAvailable) {
      updateInfoReady = true;
      return setUpdateState({
        phase: 'available',
        availableVersion: version,
        releaseNotes: notes,
        signatureUnverified: !signatureInfo().checked,
        checkedAt: new Date().toISOString(),
        message: `Доступна новая версия ${version ?? ''}. Ничего не скачивается само — нажмите «Скачать».`,
      });
    }
    return setUpdateState({
      phase: 'current',
      availableVersion: null,
      releaseNotes: notes,
      signatureUnverified: !signatureInfo().checked,
      checkedAt: new Date().toISOString(),
      message: `Установленная версия ${updateState.currentVersion} — последняя доступная.`,
    });
  } catch (error) {
    return describeUpdateFailure(error, 'Проверить обновление');
  }
});

/* Скачивание файла. Только после успешной проверки и только по кнопке. */
ipcMain.handle('update:download', async () => {
  if (!updateInfoReady) {
    return setUpdateState({
      phase: updateState.phase === 'idle' ? 'idle' : updateState.phase,
      progress: null,
      message: 'Сначала проверьте обновления: без найденной версии качать нечего.',
    });
  }
  if (updateState.phase === 'downloading') return updateSnapshot();

  const updater = getAutoUpdater();
  if (!updater) {
    return setUpdateState({
      phase: 'failed',
      progress: null,
      message: `Модуль обновления не загрузился: ${autoUpdaterLoadError?.message ?? autoUpdaterLoadError}. Скачать новую версию можно со страницы релиза.`,
    });
  }
  updater.autoDownload = false;

  setUpdateState({
    phase: 'downloading',
    progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
    message: 'Скачиваю обновление…',
  });
  try {
    await updater.downloadUpdate();
    // Итог приходит событием 'update-downloaded' — оно и переводит фазу в
    // downloaded вместе с честным предупреждением о подписи.
    return updateSnapshot();
  } catch (error) {
    return describeUpdateFailure(error, 'Скачать обновление');
  }
});

/* Установка скачанного и перезапуск. Ничего не скачано — не запускаем. */
ipcMain.handle('update:install', async () => {
  if (updateState.phase !== 'downloaded') {
    warn('установка обновления запрошена, но файл не скачан — отказ');
    return false;
  }
  const updater = getAutoUpdater();
  if (!updater) return false;
  // isSilent = false: пользователь видит окно установщика и сам решает, куда
  // ставить. Тихая установка в фоне противоречит «только по решению».
  updater.quitAndInstall(false, true);
  // Приложение сейчас закроется, и ответ, скорее всего, не дойдёт — это
  // ожидаемо, а не ошибка: renderer к этому моменту уже закрывается.
  return true;
});

/* Страница релизов в системном браузере. */
ipcMain.handle('update:open-releases', async () => {
  try {
    // Именно shell.openExternal: главное окно запрещает window.open() и уход
    // на внешний адрес (см. createWindow), поэтому из рендерера github.com
    // недостижим — ссылка открывается в браузере ОС.
    await shell.openExternal(UPDATE_REPO.releasesUrl);
    return true;
  } catch (error) {
    fail('не удалось открыть страницу релиза:', error?.message ?? error);
    return false;
  }
});

/* Иконка в трее: создаётся по запросу рендера и не блокирует выход приложения. */

const destroyTray = () => {
  if (!tray) return false;
  try {
    tray.destroy();
  } catch {
    /* уже уничтожен */
  }
  tray = null;
  log('значок в трее уничтожен');
  return true;
};

ipcMain.handle('set-tray', async (event, visible) => {
  if (!visible) {
    // Идемпотентно: выключение трея, когда его и не было, — не ошибка.
    // Раньше мост возвращал здесь false, и рендерер показывал ложное
    // уведомление «Система не разрешила создать значок в трее».
    destroyTray();
    // Без окна и без трея процесс висит невидимым и держит single-instance
    // lock — следующий запуск завершится молча, без единого окна.
    if (BrowserWindow.getAllWindows().length === 0) {
      warn('окон нет и трея нет — выходим, чтобы не остаться невидимым процессом');
      app.quit();
    }
    return true;
  }
  if (tray) return true;
  try {
    if (!fs.existsSync(ICON_PATH)) {
      fail(`иконка трея не найдена: ${ICON_PATH}`);
      return false;
    }
    tray = new Tray(ICON_PATH);
    tray.setToolTip('NEXUS Finance');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Открыть NEXUS Finance', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
        { type: 'separator' },
        { label: 'Выход', click: () => { destroyTray(); app.quit(); } },
      ]),
    );
    tray.on('click', () => { if (mainWindow) { mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show(); } });
    log('значок в трее создан:', ICON_PATH);
    return true;
  } catch (error) {
    // Трей мог уже создаться, а сбой случиться на подсказке/меню — убираем его.
    fail('не удалось создать значок в трее:', error?.message ?? error);
    destroyTray();
    return false;
  }
});

/** Что ожидаем увидеть на диске до создания окна. Ничего не чиним молча:
 *  каждая недостающая деталь печатается в терминал. */
const reportStartup = () => {
  const dbPath = getDbPath();
  log(`Electron ${process.versions.electron} / Node ${process.versions.node} / Chromium ${process.versions.chrome}`);
  log(`версия приложения: ${app.getVersion()}`);
  // Версию в состояние обновлений кладём один раз при старте — чтобы в
  // сообщениях сразу стояла настоящая, а не пустая строка. Проверки при этом
  // НЕ происходит: обновлятель в этот момент даже не загружен.
  updateState.currentVersion = app.getVersion();
  const config = updateConfigInfo();
  if (config.configFound) {
    // electron-updater пойдёт в репозиторий из app-update.yml, а не отсюда.
    // Расхождение означает, что сборка собрана с чужим build.publish — в
    // прошлой сборке там был yourusername/nexus-finance, и обновление ушло бы
    // не туда. Ловим это на старте, а не по жалобе пользователя.
    const sameRepo = config.owner === UPDATE_REPO.owner && config.repo === UPDATE_REPO.repo;
    if (sameRepo) {
      log(
        `обновления: репозиторий ${config.owner}/${config.repo}${config.channel ? `, канал ${config.channel}` : ''}; ` +
          `проверка подписи установщика: ${config.publisher ? `включена (${config.publisher})` : 'ОТКЛЮЧЕНА — сборка не подписана'}`,
      );
    } else {
      fail(
        `app-update.yml указывает на ${config.owner}/${config.repo}, а обновляться мы собираемся с ${UPDATE_REPO.owner}/${UPDATE_REPO.repo} — сборка собрана с неверным build.publish, проверка обновлений уйдёт не туда`,
      );
    }
  } else {
    warn('app-update.yml не найден — сборка сделана без настройки публикации, автообновление работать не будет');
  }
  log(`папка данных (userData): ${app.getPath('userData')}`);
  log(`файл базы: ${dbPath} — ${fs.existsSync(dbPath) ? 'найден' : 'будет создан при первом сохранении'}`);
  if (DEBUG) log('отладочный режим: откроется инспектор, лог рендерера дублируется в терминал');
  if (!fs.existsSync(DIST_ENTRY)) fail(`${BUILD_HINT} (ожидался файл ${DIST_ENTRY})`);
  if (!fs.existsSync(PRELOAD_PATH)) {
    fail(`preload.cjs не найден (${PRELOAD_PATH}) — window.electronAPI не появится, хранилище будет не тем, что ожидает рендерер`);
  }
  if (!fs.existsSync(ICON_PATH)) {
    warn(`public/favicon.ico не найден (${ICON_PATH}) — окно и значок в трее останутся без иконки`);
  }
};

/** Показать и сфокусировать главное окно: второй экземпляр, трей, macOS activate. */
const focusMainWindow = () => {
  if (!mainWindow) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return true;
};

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'NEXUS Finance',
    // Иконка опциональна: без файла Electron просто не рисует значок,
    // зато окно открывается (об отсутствии файла сказано в reportStartup).
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      preload: PRELOAD_PATH,
    },
  });

  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Никаких новых окон: весь интерфейс живёт в этом окне.
  // Лог нужен, чтобы отличить «мост сломался» от «страница сама открыла окно».
  win.webContents.setWindowOpenHandler(({ url }) => {
    warn('window.open() заблокирован:', url);
    return { action: 'deny' };
  });
  // loadFile() не шлёт will-navigate, но подстрахуемся: внутри приложения
  // допустимы только файлы самого проекта (dist/, public/).
  win.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return;
    event.preventDefault();
    warn('навигация наружу запрещена:', url);
  });

  /* ── Диагностика рендерера ──
     console.log рендерера должен быть виден в терминале, иначе отладка из
     исходников превращается в угадывание. Подпись 'console-message' менялась
     между версиями Electron: поля лежат то в объекте события, то в
     позиционных аргументах — разбираем оба варианта. */
  win.webContents.on('console-message', (event, ...rest) => {
    const details = [event, ...rest].find(
      (value) => value && typeof value === 'object' && (value.level !== undefined || value.message !== undefined),
    );
    const level = details ? details.level : rest[0];
    const message = details ? details.message : rest[1];
    const sourceId = details ? details.sourceId : rest[3];
    const line = details ? details.lineNumber ?? details.line : rest[2];
    const place = sourceId ? ` (${path.basename(String(sourceId))}:${line ?? '?'})` : '';
    const body = `${typeof message === 'string' ? message : JSON.stringify(message ?? '')}${place}`;
    const severity = level === 3 || level === 'error' ? 'error'
      : level === 2 || level === 'warning' || level === 'warn' ? 'warning'
      : 'log';
    // В консоль пишем напрямую, без префикса [main]: метка [renderer] уже есть.
    if (severity === 'error') console.error(`[renderer] ${body}`);
    else if (severity === 'warning') console.warn(`[renderer] ${body}`);
    else console.log(`[renderer] ${body}`);
    // В файл журнала — обязательно через общий сток toFile. Раньше здесь был
    // только console.*, и в собранном приложении (это GUI-сборка, окна
    // консоли нет) сообщения рендерера просто исчезали: диагностировать
    // падение было нечем.
    toFile(`[renderer]${severity === 'error' ? ' !!' : severity === 'warning' ? ' !' : ''}`, [body]);
  });
  win.webContents.on('did-finish-load', () => {
    log('рендерер загружен:', win.webContents.getURL());
  });
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (typeof errorCode !== 'number') return; // неожиданная подпись события — молчим
    const where = isMainFrame === false ? ' (подфрейм)' : '';
    fail(`страница не загрузилась${where}: ${errorDescription} (${errorCode}) — ${validatedURL}`);
  });
  // Синтаксическая ошибка в preload иначе выглядит как «мост не появился».
  win.webContents.on('preload-error', (event, preloadPath, error) => {
    fail(`preload не выполнился (${preloadPath}): ${error?.message ?? error}`);
  });
  win.webContents.on('render-process-gone', (event, details) => {
    fail(`процесс рендерера завершился: ${details?.reason} (код ${details?.exitCode})`);
  });
  win.webContents.on('unresponsive', () => warn('рендерер не отвечает — интерфейс может быть заморожен'));
  win.webContents.on('responsive', () => log('рендерер снова отвечает'));

  // Инспектор — только по --dev / NEXUS_DEVTOOLS=1, и после загрузки страницы,
  // иначе он откроется на пустом документе.
  if (DEBUG) {
    win.webContents.once('did-finish-load', () => {
      log('открываю инспектор (--dev / NEXUS_DEVTOOLS=1)');
      win.webContents.openDevTools({ mode: 'detach' });
    });
  }

  if (!fs.existsSync(DIST_ENTRY)) {
    // Молчаливый пустой экран — худший вариант отладки: показываем причину
    // в окне и в терминале, но не выходим, чтобы вывод остался читаемым.
    fail(`${BUILD_HINT} (ожидался файл ${DIST_ENTRY})`);
    showStartupError(win, 'NEXUS Finance: нечего запускать', `${BUILD_HINT}\n\nОжидался файл:\n${DIST_ENTRY}\n\nПодробности — в терминале, из которого запущен electron .`);
    return win;
  }

  // loadFile() отклоняет промис при ошибке загрузки: без catch необработанное
  // исключение уезжает в stderr без указания файла.
  win.loadFile(DIST_ENTRY).catch((error) => {
    fail(`не удалось загрузить ${DIST_ENTRY}: ${error?.message ?? error}`);
  });
  return win;
}

/* Второй экземпляр перетирал бы файл БД последним снапшотом — блокируем запуск. */
if (!app.requestSingleInstanceLock()) {
  fail('приложение уже запущено — второй экземпляр закрыт (см. первый терминал или значок в трее)');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!app.isReady()) return;
    // Окно могло быть закрыто, пока приложение живёт в трее, — создаём заново.
    if (!focusMainWindow()) createWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else focusMainWindow();
  });

  // Все ipcMain.handle выше зарегистрированы до создания окна — рендерер
  // получает готовые обработчики уже в первом кадре.
  app.whenReady()
    .then(() => {
      // Журнал открываем первым делом: в собранном приложении консоли нет, и
      // файл — единственное место, куда попадёт причина сбоя при запуске.
      openLogFile();
      if (logPath) log('файл журнала:', logPath);
      reportStartup();
      createWindow();
    })
    .catch((error) => {
      fail('запуск не удался:', error?.stack ?? error?.message ?? error);
    });
}

app.on('window-all-closed', () => {
  // С иконкой в трее приложение продолжает жить: закрыто окно — не значит выход.
  if (tray) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Выход из программы НИЧЕГО не устанавливает. Здесь нет вызова
  // quitAndInstall() и нет снятия флага autoInstallOnAppQuit — установка
  // запускается только кнопкой «Установить и перезапустить». electron-updater
  // тоже не повесит свой обработчик выхода: BaseUpdater.addQuitHandler()
  // выходит сразу, когда autoInstallOnAppQuit === false.
  destroyTray();
  notification = null;
  log('приложение завершается');
});
