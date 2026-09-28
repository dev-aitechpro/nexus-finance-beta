// src/lib/updater.ts
// Обновления программы — ИСКЛЮЧИТЕЛЬНО по явному действию пользователя.
//
// Что здесь намеренно отсутствует: фоновых проверок. Нет запроса при старте,
// по таймеру, при фокусе окна и при возврате из трея. Единственное место, где
// кто-то ходит в сеть, — обработчики кнопок в настройках. Если бы проверка
// шла сама, надпись «Проверить обновления» перестала бы означать «проверить».
//
// Файл содержит:
//   * UpdateStatus — контракт состояния. Он же уходит в главный процесс
//     (electron-main.cjs) по IPC и возвращается обратно, поэтому описан один
//     раз, а не продублирован в electronApi.ts и в мостах;
//   * адрес страницы релиза — единственный рабочий путь к новой версии там,
//     где автоматическая установка невозможна (Android) или недоступна
//     (закрытый репозиторий);
//   * хук useUpdater — состояние кнопок для экрана настроек.
import { useCallback, useEffect, useState } from "react";
import type { PlatformBridge } from "../platform/types";

/**
 * Этап обновления. Каждое значение — отдельное состояние интерфейса, а не
 * «статус на всякий случай»: экран настроек показывает его прямо, без
 * догадок по тексту сообщения.
 */
export type UpdatePhase =
  /** Проверка ещё не выполнялась. Кнопка «Проверить обновления». */
  | "idle"
  /** Идёт обращение к серверу релизов. */
  | "checking"
  /** Проверка прошла: установленная версия последняя. */
  | "current"
  /** Есть новая версия, файл ещё не скачан. */
  | "available"
  /** Идёт загрузка файла. */
  | "downloading"
  /** Файл скачан, ждём «Установить и перезапустить». */
  | "downloaded"
  /** Обновление в этом контейнере невозможно (веб-режим, запуск из исходников). */
  | "unsupported"
  /** Сервер релизов не отдал данные: репозиторий закрыт, доступа нет. */
  | "access-denied"
  /** Ошибка с установленной причиной. */
  | "failed";

/** Что умеет текущая платформа. Определяет, какие кнопки вообще показывать. */
export type UpdateMode =
  /** Полный цикл в главном процессе Electron: проверить → скачать → поставить. */
  | "electron"
  /** Только сообщение и страница релиза: Android не может заменить сам себя. */
  | "release-page"
  /** Обновления неприменимы: страница открыта в браузере. */
  | "unsupported";

/** Ход загрузки файла обновления. */
export interface UpdateProgress {
  /** 0..100, целое — так его и показывает ProgressBar. */
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

/**
 * Состояние обновлений.
 *
 * nullable у полей не означает «данных не прислали»: у каждого есть конкретный
 * смысл. `availableVersion === null` — новой версии нет (или её не удалось
 * узнать), `progress === null` — загрузка не идёт, `releaseNotes === null` —
 * автор не писал заметок к релизу.
 */
export interface UpdateStatus {
  phase: UpdatePhase;
  mode: UpdateMode;
  /** Версия запущенного приложения: app.getVersion() или versionName из Android. */
  currentVersion: string;
  /** Версия, которую предлагают поставить. null, если её нет. */
  availableVersion: string | null;
  /** Пояснение по-русски: что произошло и что делать пользователю. */
  message: string;
  /** Причина в закрытом репозитории: без доступа новую версию не увидеть. */
  needsAccess: boolean;
  /**
   * Сборка не подписана, поэтому подпись установщика никто не проверил.
   * electron-updater в этом случае молча пропускает проверку, и «успех» в его
   * логе ничего не значит — флаг выставляем сами и говорим об этом прямо.
   */
  signatureUnverified: boolean;
  releaseNotes: string | null;
  progress: UpdateProgress | null;
  /** Страница релизов: запасной путь, когда автоматика недоступна. */
  releaseUrl: string;
  /** Момент последней проверки (ISO). null — проверок ещё не было. */
  checkedAt: string | null;
}

/** Репозиторий с исходниками и релизами. Он закрыт — отсюда режим доступа. */
export const UPDATE_OWNER = "dev-aitechpro";
export const UPDATE_REPO = "nexus-finance-beta";
/** Страница, которую открываем, когда автоматическая установка невозможна. */
export const RELEASES_PAGE_URL = `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`;
/** Публичные метаданные релиза. Анонимно доступны только открытому репозиторию. */
/**
 * Именно СПИСОК релизов, а не `/releases/latest`. У последнего есть
 * ограничение, из-за которого на бете он бесполезен: GitHub считает
 * «последним релизом» только полноценный выпуск и **не возвращает
 * предварительные**. Все наши релизы помечены prerelease (версия с
 * `-beta.N` иначе GitHub не примет), поэтому `/releases/latest` отвечал бы
 * 404 всегда, а приложение показывало бы «нет доступа к закрытому
 * репозиторию» — то есть врёт о причине.
 *
 * Список отдаёт и черновики (`draft`), поэтому их надо отфильтровать, и
 * порядок задан датой публикации, а не позицией в ответе.
 */
export const RELEASES_API_URL = `https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases?per_page=5`;

/** Релиз в том виде, как его отдаёт GitHub Releases API. */
export interface ReleaseEntry {
  tag_name?: string;
  body?: string;
  html_url?: string;
  draft?: boolean;
  published_at?: string | null;
}

/** Сведение о релизе, которое видит интерфейс: версия без ведущего `v`. */
export interface ReleaseInfo {
  version: string;
  notes: string | null;
  url: string;
}

/**
 * Выбрать последний опубликованный релиз из ответа Releases API.
 *
 * Вынесено отдельно от моста Capacitor специально ради проверяемости: логика
 * разбора не должна требовать ни Android, ни модуля `@capacitor/*`. Здесь
 * же живут три правила, каждое из которых уже ломало проверку обновлений:
 *
 *   1. ответ — список, а не один объект; если формат вдруг поменяется,
 *      одиночный объект обрабатывается как список из одного элемента;
 *   2. черновики (`draft`) пропускаются: по прямой ссылке на них нельзя
 *      попасть даже автору, и предлагать пользователю несуществующую сборку
 *      нельзя;
 *   3. выбор идёт по дате публикации, а не по позиции в ответе — порядок
 *      GitHub не объявляет гарантией.
 *
 * Возвращает `null`, если опубликованных релизов нет: это «обновлений нет»,
 * а не ошибка доступа.
 */
export const pickLatestRelease = (data: unknown): ReleaseInfo | null => {
  const list = (Array.isArray(data) ? data : [data]) as ReleaseEntry[];
  const published = list
    .filter((r) => r && r.draft !== true && typeof r.tag_name === "string" && r.tag_name.trim())
    .sort((a, b) => Date.parse(b.published_at ?? "") - Date.parse(a.published_at ?? ""));
  const first = published[0];
  if (!first) return null;
  return {
    version: String(first.tag_name).replace(/^v/, "").trim(),
    notes: typeof first.body === "string" && first.body.trim() ? first.body.trim() : null,
    url: typeof first.html_url === "string" && first.html_url ? first.html_url : RELEASES_PAGE_URL,
  };
};

/** Бетой считаем версию с пререлизным суффиксом — по фактической строке версии. */
export const isBetaVersion = (version: string): boolean => /-(alpha|beta|rc|pre|dev)/i.test(version ?? "");

const parseVersion = (value: string): { parts: [number, number, number]; pre: string } => {
  const [core, pre = ""] = (value ?? "").split("-", 2);
  const parts = core.split(".").map((n) => Number.parseInt(n, 10));
  return {
    parts: [parts[0] || 0, parts[1] || 0, parts[2] || 0] as [number, number, number],
    pre,
  };
};

/**
 * Сравнение пре-суффиксов по правилам SemVer, а не как строк.
 *
 * Строковое сравнение здесь уже ломало нумерацию бет: «beta.10» меньше
 * «beta.9», потому что «1» < «9». Вышел бы десятый релиз — и приложение
 * сказало бы пользователю, что у него более свежая сборка.
 */
const comparePrerelease = (a: string, b: string): number => {
  // Отсутствие пре-суффикса «старше» любого: 1.0.0 выходит из 1.0.0-beta.1.
  if (a === "" && b === "") return 0;
  if (a === "") return 1;
  if (b === "") return -1;
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1; // меньше идентификаторов — младше
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};

/**
 * Новее ли `candidate` версии, чем установленная `current`.
 *
 * Сравнение ровно то, что нужно для сообщения пользователю: не «на сколько
 * новее», а «новее ли». При равных номерах решает пре-суффикс, и «1.0.0»
 * считается новее «1.0.0-beta.1» — выход из беты.
 */
export const isNewerVersion = (candidate: string, current: string): boolean => {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i += 1) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i];
  }
  return comparePrerelease(a.pre, b.pre) > 0;
};

/** Оговорка про бета-версию — одна на весь экран настроек. */
export const BETA_NOTE =
  "Это бета-версия: интерфейс, расчёты и формат хранения ещё могут измениться. " +
  "Данные лежат только на этом устройстве и никуда не отправляются — если ведёте реальный учёт, делайте экспорт в JSON.";

/** Что этот контейнер умеет с обновлениями — одна фраза на платформу. */
export const updateModeNote = (mode: UpdateMode): string => {
  switch (mode) {
    case "electron":
      return "Программа ничего не проверяет сама. Поиск новой версии, загрузка файла и его установка происходят только после нажатия соответствующих кнопок ниже. Ни фоновых проверок, ни установки при выходе из программы нет.";
    case "release-page":
      return "Приложение на Android не умеет обновлять само себя: для этого нужен новый APK, который устанавливает человек. Здесь мы только скажем, вышла ли новая версия, и откроем страницу релиза.";
    default:
      return "Сейчас приложение открыто в браузере. Программу здесь не устанавливают и не обновляют — страницу обновляет сам браузер. Пункт оставлен, чтобы можно было посмотреть список релизов.";
  }
};

/** Начальное состояние: ничего не проверяли, сети не касались. */
export const idleStatus = (currentVersion: string, mode: UpdateMode): UpdateStatus => ({
  phase: "idle",
  mode,
  currentVersion,
  availableVersion: null,
  message: "Обновление ещё не проверялось. Нажмите «Проверить обновления».",
  needsAccess: false,
  signatureUnverified: false,
  releaseNotes: null,
  progress: null,
  releaseUrl: RELEASES_PAGE_URL,
  checkedAt: null,
});

/** Состояние с ошибкой — то же, чем заканчиваются неудачные попытки. */
export const failedStatus = (
  currentVersion: string,
  mode: UpdateMode,
  message: string,
  needsAccess = false,
): UpdateStatus => ({
  ...idleStatus(currentVersion, mode),
  phase: needsAccess ? "access-denied" : "failed",
  message,
  needsAccess,
  checkedAt: new Date().toISOString(),
});

/** Сообщение из неизвестного исключения — коротко и по-русски. */
const reasonOf = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? "причина неизвестна";
  } catch {
    return "причина неизвестна";
  }
};

export interface Updater {
  status: UpdateStatus;
  /** Идёт сетевая операция — кнопки блокируются, чтобы не жать дважды. */
  busy: boolean;
  /** Проверить наличие новой версии. Единственное место, где идёт запрос. */
  check: () => Promise<void>;
  /** Скачать файл обновления (только после успешной проверки). */
  download: () => Promise<void>;
  /** Установить скачанное и перезапустить приложение. */
  install: () => Promise<boolean>;
  /** Открыть страницу релизов в системном браузере. */
  openReleases: () => Promise<boolean>;
}

/**
 * Состояние кнопок обновления.
 *
 * `currentVersion` приходит извне (мост платформы уже знает версию), потому
 * что версия должна браться из одного источника: app.getVersion() в Electron,
 * versionName из AndroidManifest.xml на телефоне. Второй константы с версией
 * здесь нет намеренно.
 */
export const useUpdater = (bridge: PlatformBridge, currentVersion: string): Updater => {
  const [status, setStatus] = useState<UpdateStatus>(() => idleStatus(currentVersion, bridge.updates));
  const [busy, setBusy] = useState(false);

  // Версия приходит из платформы чуть позже первого кадра. Синхронизируем её в
  // состояние, но только если главный процесс ещё ничего не сообщил: собственный
  // currentVersion из app.getVersion() точнее, чем всё, что придумает мост.
  useEffect(() => {
    setStatus((prev) => (prev.currentVersion === currentVersion ? prev : { ...prev, currentVersion }));
  }, [currentVersion]);

  // События главного процесса: ход загрузки и смена этапов. Подписка снимается
  // при смене моста, иначе в тестах и при горячей перезагрузке накапливаются
  // обработчики, каждый со своим замыканием.
  useEffect(
    () =>
      bridge.onUpdateEvent((next) => {
        setStatus((prev) => ({ ...next, currentVersion: next.currentVersion || prev.currentVersion }));
      }),
    [bridge],
  );

  // Мост — синглтон, но подстрахуемся: смена моста (тесты, горячая
  // перезагрузка) не должна оставлять в состоянии режим от прошлой платформы.
  useEffect(() => {
    setStatus((prev) => (prev.mode === bridge.updates ? prev : idleStatus(prev.currentVersion, bridge.updates)));
  }, [bridge]);

  // Проверка и загрузка отдают наружу готовый статус, поэтому try/catch нужен
  // только на случай провалившегося моста: молча проглоченная ошибка здесь
  // выглядела бы как «проверка прошла, обновлений нет».
  const check = useCallback(async () => {
    setBusy(true);
    try {
      setStatus(await bridge.checkForUpdates());
    } catch (error) {
      setStatus((prev) => failedStatus(prev.currentVersion, prev.mode, `Проверить обновление не удалось: ${reasonOf(error)}`));
    } finally {
      setBusy(false);
    }
  }, [bridge]);

  const download = useCallback(async () => {
    setBusy(true);
    try {
      setStatus(await bridge.downloadUpdate());
    } catch (error) {
      setStatus((prev) => failedStatus(prev.currentVersion, prev.mode, `Скачать обновление не удалось: ${reasonOf(error)}`));
    } finally {
      setBusy(false);
    }
  }, [bridge]);

  // Две кнопки возвращают признак «сделано»: сообщение о результате даёт тост,
  // сам текст — вызывающий код.
  const attempt = useCallback(async (action: () => Promise<boolean>): Promise<boolean> => {
    setBusy(true);
    try {
      return await action();
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const install = useCallback(() => attempt(() => bridge.installUpdate()), [attempt, bridge]);
  const openReleases = useCallback(() => attempt(() => bridge.openReleasesPage()), [attempt, bridge]);

  return { status, busy, check, download, install, openReleases };
};
