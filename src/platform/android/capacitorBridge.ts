// src/platform/android/capacitorBridge.ts
// Мост Android: слой приложения поверх контейнера Capacitor 8.
//
// Что важно знать про контейнер (проверено по исходникам @capacitor/* и по
// .d.ts в node_modules, а не по памяти):
//
//   * `window.Capacitor.Plugins` в Capacitor 3+ не существует. Плагины
//     импортируются модулями: `import { App } from "@capacitor/app"`.
//     Старое обращение `Capacitor.Plugins.LocalNotifications` не бросало ошибку,
//     а давало `undefined` — код выглядел рабочим и молча ничего не делал;
//   * аппаратная кнопка «Назад» приходит событием `backButton` плагина App.
//     Родной AppPlugin (@capacitor/app/android) отправляет его только если в JS
//     есть подписчик (`hasListeners("backButton")`), иначе уходит в ветку
//     `webView.goBack()`. Старое `document.addEventListener("backbutton", …)`
//     поэтому не срабатывало никогда. Подписка на DOM-событие больше не нужна
//     и опасна: начиная с Capacitor 7 нативный код шлёт «backbutton»
//     дополнительно, и обработчик выполнился бы дважды;
//   * локальные уведомления — `@capacitor/local-notifications`. Фолбэк
//     `new Notification()` в WebView отсутствует, как и `Notification.permission`,
//     поэтому разрешение спрашивает нативный плагин (Android 13+ —
//     POST_NOTIFICATIONS);
//   * `<a download>` в WebView не сохраняет файл: у Capacitor нет
//     `DownloadListener`, blob-URL просто игнорируется. Экспорт идёт через
//     `@capacitor/filesystem`, а отдать файл пользователю — через
//     `@capacitor/share`.
//
// Правила файла:
//   1) мост не бросает наружу — наружу уходит только `false` или корректный
//      фолбэк;
//   2) `true` означает, что действие действительно произошло: нет плагина, нет
//      разрешения, нет платформы → `false` + запись в `console.error`;
//   3) ошибки не проглатываются молча — каждая пишется в `console.error`, иначе
//      «молчаливо неработающая функция» вернётся в следующей сборке.
//
// Для React Native (рекомендация ТЗ п. 2.2) этот же интерфейс реализуется
// на вызовах expo-file-system / expo-notifications / react-native-sqlite-storage.
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Share } from "@capacitor/share";
import {
  isNewerVersion,
  pickLatestRelease,
  RELEASES_API_URL,
  RELEASES_PAGE_URL,
  type ReleaseInfo,
  type UpdateStatus,
  failedStatus,
} from "../../lib/updater";
import { createWebBridge, downloadTextFile, openReleasesInBrowser, readTextFile } from "../webBridge";
import type { PlatformBridge, PlatformFeatures } from "../types";

/** Имя плагина в том виде, в каком оно известно нативному слою. */
type PluginName = "App" | "Filesystem" | "LocalNotifications" | "Share";

/**
 * Плагин реально доступен в текущем контейнере?
 *
 * `isPluginAvailable` смотрит и на зарегистрированные JS-обёртки, и на список
 * плагинов, объявленный нативным мостом. Вторая проверка обязательна: в обычном
 * браузере на Android у веб-реализаций есть своя регистрация, и без проверки
 * `isNativePlatform()` мост считал бы плагин доступным там, где его нет.
 */
const hasNativePlugin = (name: PluginName): boolean => {
  try {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable(name);
  } catch {
    return false;
  }
};

/** Сообщение об ошибке из неизвестного исключения — коротко и по-русски. */
const reason = (e: unknown): string => {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e) ?? "причина неизвестна";
  } catch {
    return "причина неизвестна";
  }
};

/**
 * Возможности Android-контейнера.
 *
 * `notifications` и `backButton` отражают не пожелания, а наличие плагина в
 * сборке: если модуль не попал в APK (плагин не синхронизирован), честнее
 * сказать «нет», чем обещать работающую кнопку. Разрешение на уведомления —
 * величина времени выполнения, его спрашивает `notify`.
 */
const androidFeatures = (): PlatformFeatures => ({
  tray: false, // системного трея на Android нет
  nativeDialogs: false, // нативный выбор файла открывает сам WebView
  notifications: hasNativePlugin("LocalNotifications"),
  backButton: hasNativePlugin("App"),
  // Папки с данными, которую можно «показать», у WebView нет: файлы лежат в
  // приватном хранилище приложения, и настройки не будут предлагать кнопку,
  // которая ничего не делает.
  dataFolder: false,
});

/**
 * Где физически лежат данные на Android.
 *
 * Схема хранения — src/storage/snapshots.ts (IDB_NAME / IDB_STORE / IDB_KEY).
 * Файла sqlite://nexus-finance.db на Android не существует: база лежит
 * записью в IndexedDB внутри приватного хранилища WebView, поэтому прежний
 * текст в настройках был неправдой. Константы здесь продублированы намеренно —
 * storageHint() по контракту синхронный, а IDB_NAME в snapshots.ts не экспортируется.
 */
const STORAGE_HINT = "indexeddb://nexus-finance/db.sqlite (внутри приватного хранилища приложения)";

/** Порядок попыток записи файла: от «пользователь видит» к «всегда доступно». */
const WRITE_TARGETS: readonly Directory[] = [
  // Публичная папка «Документы»: файл видно в файловом менеджере, ничего
  // отдавать не нужно. На Android 11+ запись в неё может быть запрещена
  // scoped storage — тогда срабатывает следующая цель.
  Directory.Documents,
  // Внешняя папка приложения (/storage/emulated/0/Android/data/<id>/files):
  // разрешение не требуется, но файл не лежит на виду — отдаём его через Share.
  Directory.External,
];

/** Идентификаторы уведомлений: 32-битный int, каждый раз новый. */
let lastNotificationId = 1000;
const nextNotificationId = (): number => {
  lastNotificationId = lastNotificationId >= 2_000_000_000 ? 1000 : lastNotificationId + 1;
  return lastNotificationId;
};

/**
 * Безопасное имя файла для экспорта: только базовое имя.
 *
 * Имя приходит из кода приложения, но плагин пишет его на файловую систему,
 * поэтому путь приводится к одному сегменту: без разделителей каталогов,
 * без управляющих символов, без «..». Иначе можно уйти из папки назначения.
 */
const safeFileName = (name: string): string => {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "export.json";
  return cleaned;
};

/**
 * Отдать записанный файл пользователю системным меню «Поделиться».
 *
 * Нужно там, где файл попал в папку приложения: сам пользователь до неё не
 * доберётся. Отмена пользователем ошибкой не считается — файл на устройстве
 * лежит, поэтому результат `true`, а неудача пишется в `console.error`.
 */
const shareFile = async (uri: string, fileName: string): Promise<boolean> => {
  if (!hasNativePlugin("Share")) {
    console.error("NEXUS: файл записан в папку приложения, но плагин Share недоступен — отдать файл нечем");
    return true;
  }
  // Share на Android ждёт file:-URL, а Filesystem в зависимости от версии
  // отдаёт URI то со схемой, то без неё — приводим к file:// явно.
  const fileUrl = /^file:/i.test(uri) ? uri : `file://${uri.startsWith("/") ? uri : `/${uri}`}`;
  try {
    const supported = await Share.canShare();
    if (!supported.value) {
      console.error("NEXUS: система не поддерживает отправку файла через меню «Поделиться»");
      return true;
    }
    await Share.share({
      title: fileName,
      files: [fileUrl],
      dialogTitle: "Сохранить или отправить копию файла",
    });
    return true;
  } catch (e) {
    // Отмена пользователем тоже сюда попадает — это не ошибка сохранения.
    console.error(`NEXUS: не удалось открыть меню «Поделиться» для ${fileName}: ${reason(e)}`);
    return true;
  }
};

/**
 * Поведение «назад» по умолчанию, когда приложение не перехватило нажатие.
 *
 * Как только в JS есть подписчик `backButton`, родной AppPlugin больше не
 * трогает WebView: событие потреблено нативной стороной, и «отдать его системе»
 * значит выполнить то, что сделал бы сам Capacitor, — вернуться по истории
 * WebView, а если истории нет, закрыть Activity.
 */
const passBackToSystem = (canGoBack: boolean): void => {
  try {
    if (canGoBack && typeof window !== "undefined" && window.history.length > 1) {
      window.history.back();
      return;
    }
    void App.exitApp().catch((e: unknown) => {
      console.error(`NEXUS: не удалось закрыть приложение по кнопке «Назад»: ${reason(e)}`);
    });
  } catch (e) {
    console.error(`NEXUS: кнопка «Назад» не обработана: ${reason(e)}`);
  }
};

export const detectAndroid = (): boolean => {
  if (Capacitor.getPlatform() === "android") return true;
  if (typeof navigator === "undefined") return false;
  return /Android/i.test(navigator.userAgent);
};

/* ── Обновления на Android ────────────────────────────────────────────────────
 *
 * Самообновление здесь невозможно технически, и об этом нужно говорить прямо,
 * а не делать вид: WebView в контейнере Capacitor не может заменить собственный
 * APK — это может только пользователь, поставив новый файл. Поэтому мост умеет
 * ровно две вещи: сказать, вышла ли новая версия, и открыть страницу релиза.
 *
 * Про версию берётся из публичного API GitHub Releases. Что важно знать про
 * этот запрос (проверено по коду и по настройкам сборки):
 *   * репозиторий закрыт, поэтому анонимный запрос получает 404 — и мы говорим
 *     «нужен доступ», а не «новых версий нет»: второе было бы неправдой,
 *     потому что мы ничего не узнали;
 *   * в продакшен-сборке connect-src политики безопасности не содержит
 *     api.github.com (см. vite.config.ts), и запрос блокируется браузером. Это
 *     тоже распознаётся (обычно как «Failed to fetch») и показывается честно.
 * В обоих случаях рабочее действие одно — открыть страницу релиза, где
 * пользователь (скорее всего, уже вошедший в GitHub под своей учёткой) сам
 * увидит список версий и скачает APK. */

/**
 * Статус обновления на Android.
 *
 * Фаза выводится из needsAccess, если её не задали явно. Иначе легко получить
 * needsAccess = true вместе с фазой «failed»: сообщение «нужен доступ» на
 * нейтральном, ничего не значащем фоне, и сценарий «закрытый репозиторий»
 * становится неотличим от обычной ошибки сети. Здесь такой рассинхрон
 * невозможен по построению.
 */
const androidUpdateStatus = (currentVersion: string, patch: Partial<UpdateStatus>): UpdateStatus => {
  const needsAccess = patch.needsAccess === true;
  return {
    ...failedStatus(currentVersion, "release-page", ""),
    ...patch,
    phase: patch.phase ?? (needsAccess ? "access-denied" : "failed"),
    needsAccess,
  };
};

/**
 * Ответ GitHub Releases API, насколько он нам нужен.
 * Разбор ответа вынесен в `pickLatestRelease` (src/lib/updater.ts) — там же
 * проверяется, что берётся последний *опубликованный* релиз, а не черновик.
 */
const readLatestRelease = async (signal?: AbortSignal): Promise<ReleaseInfo | null> => {
  const response = await fetch(RELEASES_API_URL, {
    headers: { Accept: "application/vnd.github+json" },
    // Без таймаута запрос висит до системного лимита сети, и кнопка «Проверить»
    // остаётся заблокированной. Пользователь ждёт секунды, а не минуты.
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    // Статус пробрасываем отдельным полем: по нему отличаем «нет доступа» (401/403/404)
    // от «сервер недоволен» (5xx) и от «сети нет» (fetch бросил, а не ответил).
    throw Object.assign(new Error(`GitHub ответил кодом ${response.status}`), { status: response.status });
  }
  return pickLatestRelease(await response.json());
};

/**
 * Открыть страницу релизов так, чтобы это сработало в контейнере.
 *
 * В WebView Capacitor переход на внешний адрес перехватывает
 * BridgeWebViewClient.shouldOverrideUrlLoading → Bridge.launchIntent →
 * Intent.ACTION_VIEW, то есть открывается системный браузер. Именно поэтому
 * здесь присваивание location.href, а не window.open(): в Capacitor 8
 * BridgeWebChromeClient не переопределяет onCreateWindow, и window.open просто
 * ничего не делает. В обычном браузере на Android (контейнера нет) такое
 * присваивание уводило бы со страницы само приложение, поэтому там —
 * window.open, как в веб-версии.
 */
const openReleases = (url: string): boolean => {
  if (!/^https:\/\//i.test(url)) return false;
  if (!Capacitor.isNativePlatform()) return openReleasesInBrowser(url);
  try {
    window.location.href = url;
    return true;
  } catch (e) {
    console.error(`NEXUS: не удалось открыть страницу релиза: ${reason(e)}`);
    return openReleasesInBrowser(url);
  }
};

/**
 * Сравнение версий живёт в `src/lib/updater.ts` (`isNewerVersion`) — там же
 * оно и проверяется тестами. Повторять его здесь нельзя: две копии правил
 * сравнения рано или поздно разойдутся, и сообщение «у вас актуальная
 * версия» будет опираться на не ту.
 */

export const createAndroidBridge = (): PlatformBridge => {
  const web = createWebBridge("android");
  return {
    kind: "android",
    native: Capacitor.isNativePlatform(),
    features: androidFeatures(),
    appVersion: async () => {
      if (!hasNativePlugin("App")) return web.appVersion();
      try {
        // На Android это versionName из AndroidManifest.xml, а не константа
        // бандла: Settings показывает версию пользователю, и «1.0.0» вручную
        // была бы неправдой после первого же релиза.
        const info = await App.getInfo();
        const version = info.version?.trim();
        return version || web.appVersion();
      } catch (e) {
        console.error(`NEXUS: не удалось получить версию приложения из Android: ${reason(e)}`);
        return web.appVersion();
      }
    },
    storageHint: () => STORAGE_HINT,
    // Открывать нечего: у WebView нет пользовательской папки. Пункт в
    // настройках прячется по features.dataFolder === false.
    openDataFolder: async () => false,
    // <input type="file"> в WebView обрабатывает WebChromeClient контейнера —
    // системный выбор файла открывается, accept доходит до диалога.
    pickTextFile: (accept) => readTextFile(accept),
    saveTextFile: async (name, content) => {
      const fileName = safeFileName(name);
      if (!hasNativePlugin("Filesystem")) {
        // В контейнере без плагина файловой системы `<a download>` безвреден,
        // но и бесполезен: WebView его не выполняет. В обычном браузере на
        // Android (Capacitor тут нет) веб-загрузка, наоборот, единственный
        // рабочий путь — поэтому ветвим по наличию контейнера.
        if (Capacitor.isNativePlatform()) {
          console.error("NEXUS: плагин Filesystem не входит в сборку — экспорт в файл невозможен");
          return false;
        }
        return downloadTextFile(fileName, content);
      }

      let saved: { uri: string; visible: boolean } | null = null;
      let lastError = "неизвестная ошибка";
      for (const directory of WRITE_TARGETS) {
        try {
          // recursive не нужен: safeFileName оставляет ровно один сегмент пути,
          // значит создавать родительские каталоги не из чего.
          const result = await Filesystem.writeFile({
            path: fileName,
            data: content,
            directory,
            encoding: Encoding.UTF8,
          });
          saved = { uri: result.uri, visible: directory === Directory.Documents };
          break;
        } catch (e) {
          lastError = `${directory}: ${reason(e)}`;
        }
      }
      if (!saved) {
        console.error(`NEXUS: не удалось сохранить ${fileName} — ${lastError}`);
        return false;
      }
      // В «Документах» файл пользователь найдёт сам. Из папки приложения его
      // можно только отдать наружу.
      return saved.visible ? true : shareFile(saved.uri, fileName);
    },
    notify: async (title, body) => {
      if (!hasNativePlugin("LocalNotifications")) {
        console.error("NEXUS: плагин LocalNotifications не входит в сборку — уведомление некуда отправлять");
        return false;
      }
      try {
        // Android 13+ без POST_NOTIFICATIONS уведомление просто не покажется,
        // поэтому разрешение спрашиваем сами и честно отвечаем false, если его
        // не дали. На старых версиях checkPermissions отдаёт состояние
        // системной настройки, и requestPermissions ничего не меняет.
        let status = await LocalNotifications.checkPermissions();
        if (status.display !== "granted") {
          status = await LocalNotifications.requestPermissions();
        }
        if (status.display !== "granted") {
          console.error("NEXUS: уведомления не показаны — разрешение не выдано");
          return false;
        }
        await LocalNotifications.schedule({
          notifications: [
            {
              // Один и тот же id перезаписывает предыдущее уведомление, поэтому
              // каждое получает свой.
              id: nextNotificationId(),
              title,
              body: body ?? "",
              // Уведомление нужно прямо сейчас. По умолчанию плагин
              // планирует его «точным будильником» и на Android 12+ открывает
              // экран «Точные будильники» — лишний диалог ради мгновенного
              // показа.
              isExactNotification: false,
            },
          ],
        });
        return true;
      } catch (e) {
        console.error(`NEXUS: не удалось показать уведомление: ${reason(e)}`);
        return false;
      }
    },
    /**
     * Аппаратная кнопка «Назад» (Capacitor 3+): событие backButton плагина App.
     * Возвращает синхронную отписку, хотя подписка нативная и асинхронная:
     * если отписаться раньше, чем пришёл PluginListenerHandle, подписку
     * снимаем сразу, как только он появится.
     */
    onBackButton: (handler) => {
      if (!handler || !hasNativePlugin("App")) return () => undefined;
      let disposed = false;
      let detach: (() => void) | null = null;
      const pending = App.addListener("backButton", (event) => {
        let handled = false;
        try {
          handled = handler();
        } catch (e) {
          // Обработчик — это код приложения (закрыть модалку, сменить экран).
          // Его исключение не должно оставлять кнопку «Назад» мёртвой.
          console.error(`NEXUS: обработчик кнопки «Назад» бросил исключение: ${reason(e)}`);
        }
        // false означает «мы не перехватили» — событие уже израсходовано
        // нативной стороной, поэтому системное поведение воспроизводим сами.
        if (!handled) passBackToSystem(event.canGoBack);
      });
      void pending
        .then((listener) => {
          if (disposed) {
            void listener.remove().catch(() => undefined);
            return;
          }
          detach = () => {
            void listener.remove().catch(() => undefined);
          };
        })
        .catch((e: unknown) => {
          console.error(`NEXUS: не удалось подписаться на кнопку «Назад»: ${reason(e)}`);
        });
      return () => {
        disposed = true;
        detach?.();
      };
    },
    setTray: async () => false,

    /* ── Обновления: только сообщение и страница релиза ──
     *
     * Ни скачивания, ни установки на Android нет и не будет: файл APK
     * заменяет человек. Кнопки «Скачать» и «Установить» поэтому настройки на
     * этой платформе не показывают (см. updateMode в настройках), а вместо них
     * предлагают открыть страницу релиза. */
    updates: "release-page",
    checkForUpdates: async (): Promise<UpdateStatus> => {
      const currentVersion = await web.appVersion();
      try {
        const release = await readLatestRelease();
        if (!release) {
          // Доступ есть (иначе был бы 404), релизов просто ещё нет. Это
          // «обновлений нет», а не ошибка: так сообщать нельзя, иначе
          // предложение открыть браузер появится у первого подписчика.
          return androidUpdateStatus(currentVersion, {
            phase: "current",
            availableVersion: null,
            checkedAt: new Date().toISOString(),
            message: "В репозитории пока нет опубликованных релизов — обновлений нет.",
          });
        }
        if (!isNewerVersion(release.version, currentVersion)) {
          return androidUpdateStatus(currentVersion, {
            phase: "current",
            availableVersion: null,
            checkedAt: new Date().toISOString(),
            message: `Установленная версия ${currentVersion} — последняя доступная.`,
          });
        }
        return androidUpdateStatus(currentVersion, {
          phase: "available",
          availableVersion: release.version,
          releaseNotes: release.notes,
          checkedAt: new Date().toISOString(),
          message: `Вышла версия ${release.version}. Установить её нужно вручную: приложение не может заменить само себя — скачайте APK со страницы релиза.`,
        });
      } catch (e) {
        const status = typeof (e as { status?: unknown } | null)?.status === "number" ? (e as { status: number }).status : null;
        // 404 GitHub отдаёт и на закрытый репозиторий, и на его отсутствие.
        // В обоих случаях вывод один и тот же — доступа к данным нет.
        if (status !== null && (status === 401 || status === 403 || status === 404)) {
          return androidUpdateStatus(currentVersion, {
            needsAccess: true,
            message: "GitHub не отдал данные о релизе: репозиторий закрыт, а приложение ходит в него без входа в учётную запись. Токен внутрь программы не вшивается намеренно. Откройте страницу релиза в браузере — вы, скорее всего, уже вошли в GitHub.",
          });
        }
        if (status !== null && status >= 500) {
          return androidUpdateStatus(currentVersion, {
            message: `GitHub сейчас не отвечает (код ${status}). Проверка не удалась — это не значит, что обновлений нет. Попробуйте позже или откройте страницу релиза.`,
          });
        }
        // Сюда попадает и блокировка запроса политикой безопасности сборки
        // (connect-src не содержит api.github.com — см. vite.config.ts):
        // браузер обрывает запрос, и fetch даёт TypeError без кода.
        console.error(`NEXUS: проверка обновлений на Android не удалась: ${reason(e)}`);
        return androidUpdateStatus(currentVersion, {
          message: `Проверить обновление не удалось: ${reason(e)}. Чаще всего это значит, что запрос к GitHub заблокирован политикой безопасности сборки или нет сети. Наличие новой версии можно посмотреть на странице релиза.`,
        });
      }
    },
    downloadUpdate: async (): Promise<UpdateStatus> => {
      const currentVersion = await web.appVersion();
      return androidUpdateStatus(currentVersion, {
        message: "Скачивание внутри приложения не выполняется: на Android новую версию ставит пользователь, файлом APK. Откройте страницу релиза и скачайте его оттуда.",
      });
    },
    installUpdate: async () => false,
    openReleasesPage: async () => openReleases(RELEASES_PAGE_URL),
    onUpdateEvent: () => () => {
      /* событий нет: загрузки внутри приложения не бывает */
    },
  };
};
