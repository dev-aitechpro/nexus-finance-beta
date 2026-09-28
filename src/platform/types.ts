// src/platform/types.ts
// Единый интерфейс доступа к возможностям платформы (ТЗ Группа 2).
// Верхний код не знает, Windows это, Android или браузер: различия
// скрыты внутри адаптера.
import type { UpdateMode, UpdateStatus } from "../lib/updater";

export type PlatformKind = "windows" | "macos" | "linux" | "android" | "ios" | "web";

export interface PickedFile {
  name: string;
  text: string;
}

export interface PlatformFeatures {
  /** Системный трей (Windows). */
  tray: boolean;
  /** Нативные диалоги открытия/сохранения. */
  nativeDialogs: boolean;
  /** Нативные уведомления. */
  notifications: boolean;
  /** Аппаратная кнопка «Назад» (Android). */
  backButton: boolean;
  /**
   * Есть ли папка с данными, которую вообще можно открыть (Проводник/Finder).
   *
   * Поле необязательное и трактуется как «возможность есть, если не сказано
   * иначе»: мосты, которые этот признак не описывают, открывать папку умеют.
   * Значение `false` — честный отказ: в Android-контейнере у WebView нет
   * пользовательской папки, открывать нечего, и пункт в настройках прячется.
   */
  dataFolder?: boolean;
}

export interface PlatformBridge {
  readonly kind: PlatformKind;
  /** true, если мост ведёт в нативный слой, а не в браузер. */
  readonly native: boolean;
  readonly features: PlatformFeatures;
  /** Версия приложения: в Electron приходит из app.getVersion(), в web — из констант. */
  appVersion(): Promise<string>;
  /** Где физически лежат данные — для экрана настроек. */
  storageHint(): string;
  /** Открыть папку с данными (Проводник/Finder). */
  openDataFolder(): Promise<boolean>;
  /** Выбрать текстовый файл (импорт). */
  pickTextFile(accept?: string): Promise<PickedFile | null>;
  /** Сохранить текстовый файл (экспорт). */
  saveTextFile(name: string, content: string): Promise<boolean>;
  /** Уведомление. */
  notify(title: string, body?: string): Promise<boolean>;
  /** Обработчик аппаратной кнопки «Назад». Возвращает отписку. */
  onBackButton(handler: (() => boolean) | null): () => void;
  /** Показать/скрыть иконку в трее (Windows). */
  setTray(visible: boolean): Promise<boolean>;

  /* ── Обновления ──
   *
   * Обновление приходит только по явному действию пользователя, поэтому здесь
   * нет ни одной подписки «проверь при старте»: сетевые методы зовутся только
   * обработчиками кнопок. Что именно умеет платформа, сообщает `updates` —
   * по нему настройки решают, какие кнопки показывать, а не гадают по
   * PlatformKind. */
  /** Режим обновлений этой платформы. */
  readonly updates: UpdateMode;
  /** Проверить наличие новой версии. Нигде не вызывается автоматически. */
  checkForUpdates(): Promise<UpdateStatus>;
  /** Скачать файл обновления. Вызывается только после успешной проверки. */
  downloadUpdate(): Promise<UpdateStatus>;
  /** Установить скачанное и перезапустить. */
  installUpdate(): Promise<boolean>;
  /** Открыть страницу релизов в системном браузере. */
  openReleasesPage(): Promise<boolean>;
  /** События хода загрузки и смены этапов. Возвращает отписку. */
  onUpdateEvent(handler: (status: UpdateStatus) => void): () => void;
}
