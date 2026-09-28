// map.config.ts
// Конфигурация генератора карты проекта (ТЗ п. 6).
//
// Карта решает две задачи:
//  1) экономия токенов — агенту достаточно посмотреть список модулей и их
//     назначение, а не читать весь код;
//  2) контроль архитектуры — видно, что новые подсистемы лежат в правильных
//     каталогах (storage / platform / animations), а не размазаны по src/lib.

export interface MapEntry {
  path: string;
  title: string;
  summary: string;
  /** Ключевые экспорты — что искать в файле. */
  exports?: string[];
  layer: "domain" | "storage" | "platform" | "ui" | "state" | "infra" | "test";
}

export interface MapConfig {
  root: string;
  outFile: string;
  ignore: string[];
  entryPoints: string[];
  modules: MapEntry[];
  /** Каталоги верхнего уровня и их роль — попадают в корень карты. */
  areas: { path: string; role: string }[];
  /** Именованные цепочки потоков данных (раздел data-flow в ТЗ). */
  dataFlows?: { id: string; steps: string[]; note?: string }[];
  /** История крупных задач (раздел task-history, необязательный в ТЗ). */
  taskHistory?: { task: string; status: "done" | "in-progress" | "planned"; files: string[]; note?: string }[];
}

const config: MapConfig = {
  root: ".",
  outFile: "project-map.json",
  ignore: [
    "node_modules",
    "dist",
    "dist-electron",
    "coverage",
    ".git",
    "project-map.json",
    "src/lib/engine1.ts",
    "src/hooks/useKeyboard.ts",
  ],
  entryPoints: [
    "index.html",
    "index.dev.html",
    "electron-main.cjs",
    "preload.cjs",
    "vite.shared.ts",
    "vite.config.ts",
    "vite.dev.config.ts",
    "vitest.config.ts",
    "map.config.ts",
    "project-map.json",
  ],
  areas: [
    { path: "src/storage", role: "Слой хранения: SQLite + миграция с localStorage (ТЗ Группа 1)" },
    { path: "src/animations", role: "Delta-time и WAAPI-анимации, деградация на слабых устройствах (ТЗ Группа 3)" },
    { path: "src/platform", role: "Мосты платформы: Windows / Android / web (ТЗ Группа 2)" },
    { path: "src/components", role: "UI-компоненты и онбординг" },
    { path: "src/views", role: "Экраны приложения" },
    { path: "src/hooks", role: "Состояние приложения и хуки" },
    { path: "src/lib", role: "Доменная логика: расчёты, константы, типы, фасад хранилища" },
    { path: "tests", role: "Тесты: хранилище (миграции, транзакции, откат) и анимации (60/144 Гц)" },
    { path: "scripts", role: "Скрипты npm: генератор карты проекта, проверка собранного артефакта" },
    { path: "docs", role: "Документация: отчёт о выполнении ТЗ" },
  ],
  modules: [
    {
      path: "src/storage/types.ts",
      title: "Контракты хранилища",
      summary: "SqlDriver (SQL-уровень) и StorageAdapter (документный уровень), SnapshotStore.",
      exports: ["StorageAdapter", "SqlDriver", "SnapshotStore", "CollectionKey"],
      layer: "storage",
    },
    {
      path: "src/storage/schema.ts",
      title: "Схема SQLite",
      summary: "По таблице на коллекцию AppData, индексы по фильтруемым полям, версия схемы и шаги миграций.",
      exports: ["COLLECTION_SPECS", "SCHEMA_VERSION", "MIGRATIONS", "upsertRowOp"],
      layer: "storage",
    },
    {
      path: "src/storage/sqlite.ts",
      title: "SQLite-адаптер (sql.js)",
      summary: "Драйвер с транзакциями/откатом и документный адаптер с дифф-записью и снапшотами БД.",
      exports: ["SqliteSqlDriver", "SqliteStorage", "browserSqlJsLoader"],
      layer: "storage",
    },
    {
      path: "src/storage/memory.ts",
      title: "Адаптер в памяти",
      summary: "Тесты и деградация: транзакции через снимок состояния, откат при ошибке.",
      exports: ["MemoryStorage"],
      layer: "storage",
    },
    {
      path: "src/storage/snapshots.ts",
      title: "Хранилища снапшота БД",
      summary: "Файл в userData (Electron) → IndexedDB (браузер) → localStorage → память.",
      exports: ["createSnapshotStore", "ElectronSnapshotStore", "IndexedDbSnapshotStore"],
      layer: "storage",
    },
    {
      path: "src/storage/migrate.ts",
      title: "Миграция с localStorage",
      summary: "Импорт наследия в одну транзакцию; исходный ключ сохраняется для отката.",
      exports: ["migrateLegacyData", "LEGACY_MIGRATION_FLAG", "readLegacySource"],
      layer: "storage",
    },
    {
      path: "src/storage/index.ts",
      title: "Точка входа хранилища",
      summary: "Выбор драйвера, ленивая инициализация, описание хранилища для настроек.",
      exports: ["getStorage", "describeStorage", "resetStorage", "migrationStatus"],
      layer: "storage",
    },
    {
      path: "src/storage/wasmAsset.ts",
      title: "Встроенный WASM",
      summary: "Статический импорт sql-wasm.wasm через запрос ?wasm-inline (плагин vite.shared.ts).",
      layer: "storage",
    },
    {
      path: "src/lib/normalize.ts",
      title: "Нормализация документа",
      summary: "Приведение любого источника к валидному AppData, слияние документов, проверка пустоты.",
      exports: ["normalizeAppData", "mergeAppData", "isEmptyAppData", "withCompleteShape"],
      layer: "storage",
    },
    {
      path: "src/lib/storage.ts",
      title: "Фасад хранилища",
      summary: "storageService.load/save/clear поверх адаптера, экспорт/импорт файла, Яндекс Диск.",
      exports: ["storageService", "serializeExport", "parseImport", "storageInfo"],
      layer: "storage",
    },
    {
      path: "src/animations/ticker.ts",
      title: "Delta-time цикл",
      summary: "Скорость в единицах в секунду: анимация одинакова на 60 и 144 Гц; ограничение длинного кадра.",
      exports: ["createTicker", "createValueTransition", "stepLinear"],
      layer: "state",
    },
    {
      path: "src/animations/waapi.ts",
      title: "WAAPI-переходы",
      summary: "Анимации только transform/opacity, отключение на слабом устройстве и при reduced-motion, stagger с лимитом.",
      exports: ["animate", "resolveMotionPlan", "riseIn", "scaleProgress", "stagger"],
      layer: "state",
    },
    {
      path: "src/platform/capabilities.ts",
      title: "Возможности устройства",
      summary: "Определение RAM/ядер/reduced-motion, уровень low/mid/high, data-perf на <html>.",
      exports: ["detectCapabilities", "applyCapabilities", "describeTier"],
      layer: "platform",
    },
    {
      path: "src/platform/index.ts",
      title: "Выбор платформы",
      summary: "Определение Windows/Android/web и создание соответствующего моста.",
      exports: ["platform", "detectPlatform"],
      layer: "platform",
    },
    {
      path: "src/platform/windows/electronBridge.ts",
      title: "Мост Windows",
      summary: "Данные в файле SQLite в userData, открытие папки с данными.",
      exports: ["createElectronBridge", "detectWindows"],
      layer: "platform",
    },
    {
      path: "src/platform/android/capacitorBridge.ts",
      title: "Мост Android",
      summary: "Подготовка к Capacitor: хранилище в файловой системе, кнопка «Назад», уведомления.",
      exports: ["createAndroidBridge", "detectAndroid"],
      layer: "platform",
    },
    {
      path: "src/hooks/AppProvider.tsx",
      title: "Состояние приложения",
      summary: "Загрузка и дебаунс сохранения через storageService, операции над данными, тосты.",
      exports: ["AppProvider", "useApp"],
      layer: "state",
    },
    {
      path: "src/hooks/useCapabilities.ts",
      title: "Хук возможностей устройства",
      summary: "Одноразовое определение устройства + реакция на смену prefers-reduced-motion.",
      exports: ["useCapabilities"],
      layer: "state",
    },
    {
      path: "src/hooks/usePlatformBackButton.ts",
      title: "Аппаратная кнопка «Назад»",
      summary: "Через PlatformBridge: закрывает модалку, затем возвращает на главный экран.",
      exports: ["usePlatformBackButton"],
      layer: "state",
    },
    {
      path: "src/components/CategoryPicker.tsx",
      title: "Выбор категории с иконками",
      summary: "Сетка плиток с иконкой и цветом категории вместо нативного <select> (в select иконку показать нельзя).",
      exports: ["CategoryPicker", "CategoryChipRow"],
      layer: "ui",
    },
    {
      path: "src/components/Onboarding.tsx",
      title: "Онбординг",
      summary: "4 шага на русском, показ один раз по флагу в БД.",
      exports: ["Onboarding", "ONBOARDING_FLAG"],
      layer: "ui",
    },
    {
      path: "src/views/Settings.tsx",
      title: "Настройки",
      summary: "Раздел «Хранилище данных»: драйвер, режим журнала, размер БД, режим графики; бэкапы.",
      exports: ["Settings"],
      layer: "ui",
    },
    {
      path: "tests/storage.test.ts",
      title: "Тесты хранилища",
      summary: "Схема, round-trip, UPSERT, транзакции, откат, персистентность, миграции.",
      layer: "test",
    },
    {
      path: "tests/subscriptions.test.ts",
      title: "Тесты регулярных платежей",
      summary: "Удаление не воскресает, месяц закрывается, платежи будущего месяца не требуют подтверждения.",
      layer: "test",
    },
    {
      path: "tests/animations.test.ts",
      title: "Тесты анимаций",
      summary: "Независимость от 60/144 Гц, лимит длинного кадра, деградация, определение устройства.",
      layer: "test",
    },
    {
      path: "vite.shared.ts",
      title: "Плагин сборки WASM",
      summary: "Отдаёт .wasm как JS-модуль с base64: нужно для SQLite и для single-file сборки под file://.",
      exports: ["wasmInlinePlugin", "WASM_INLINE_QUERY"],
      layer: "infra",
    },
    {
      path: "scripts/generate-project-map.mjs",
      title: "Генератор карты проекта",
      summary: "Сканирует файлы, объединяет ручные описания из map.config.ts, пишет project-map.json.",
      layer: "infra",
    },
    {
      path: "scripts/check-dist.mjs",
      title: "Проверка артефакта сборки",
      summary: "Ищет голые импорты node-модулей и внешние js/css в dist/index.html до релиза.",
      layer: "infra",
    },
    {
      path: "scripts/bench-storage.mjs",
      title: "Бенчмарки хранилища",
      summary: "Холодный старт, восстановление из снапшота, запись/чтение, задержка SQL-запроса.",
      layer: "infra",
    },
    {
      path: "docs/Выполнение-ТЗ.md",
      title: "Отчёт о выполнении ТЗ",
      summary: "Что сделано по группам 1–5 и §6, как проверить и что осталось за рамками среды.",
      layer: "infra",
    },
    {
      path: "scripts/build-windows.mjs",
      title: "Сборка установщика Windows",
      summary:
        "Релизная сборка Windows: vite build + electron-builder (NSIS и portable). Ставит зеркало бинарей, повторяет сборку при обрыве сети, печатает путь и размер установщика.",
      layer: "infra",
    },
    {
      path: "scripts/build-android.mjs",
      title: "Сборка APK (Android)",
      summary:
        "Релизная сборка Android: находит SDK и JDK, пишет local.properties, делает cap sync и сверяет бандл по SHA-256, повторяет gradle при обрыве TLS, печатает badging готового APK.",
      layer: "infra",
    },
    {
      path: "scripts/check-file-protocol.mjs",
      title: "Проверка протокола file://",
      summary:
        "Проверяет, что собранный бандл пригоден под file:// и мобильный WebView: абсолютные src/href, url(/…), fetch(\"/…\"), import(\"/…\"), service worker, следы base: \"/\".",
      layer: "infra",
    },
    {
      path: "scripts/check-desktop-db.mjs",
      title: "Проверка базы в профиле",
      summary:
        "Читает рабочий файл SQLite из профиля пользователя: сигнатура, sql.js, PRAGMA quick_check, состав таблиц и число строк.",
      layer: "infra",
    },
    {
      path: "scripts/check-docs.mjs",
      title: "Проверка документации",
      summary:
        "Ищет битые Markdown-ссылки и якоря, а также устаревшие упоминания файлов в обратных кавычках — то, что протухает в документации молча.",
      layer: "infra",
    },
    {
      path: "docs/Решение-проблем.md",
      title: "Решение проблем",
      summary: "Симптом → причина → решение: запуск, база, сборка, CSP, сеть, Android и чего делать нельзя.",
      layer: "infra",
    },
    {
      path: "docs/Архитектура.md",
      title: "Архитектура",
      summary: "Устройство системы: слои, хранилище, домен, платформенный слой, IPC, сборка, анимации, риски.",
      layer: "infra",
    },
    {
      path: "docs/Разработка.md",
      title: "Руководство разработчика",
      summary: "Как разрабатывать: требования, запуск, обязательные проверки, соглашения, ловушки, чек-лист ревью.",
      layer: "infra",
    },
    {
      path: "docs/Лицензирование.md",
      title: "Лицензирование",
      summary:
        "Лицензия ещё не выбрана: сравнение вариантов, критерии выбора, лицензии зависимостей и чек-лист оформления решения.",
      layer: "infra",
    },
  ],
  dataFlows: [
    {
      id: "app-start",
      note: "Холодный старт приложения.",
      steps: [
        "src/main.tsx → src/App.tsx",
        "AppProvider → storageService.load",
        "src/storage/index.ts → createStorageAdapter",
        "src/storage/sqlite.ts → browserSqlJsLoader (WASM из ?wasm-inline)",
        "SqliteSqlDriver.open → applySchema (CREATE TABLE/INDEX + SCHEMA_VERSION)",
        "snapshots.load → db.export() → восстановление БД",
        "migrateLegacyData (если флаг migration.legacy.v1 не выставлен)",
        "App → useCapabilities → data-perf на <html>",
        "App → Onboarding (если нет флага ui.onboarded.v1)",
      ],
    },
    {
      id: "write-transaction",
      note: "Добавление операции и её попадание на диск.",
      steps: [
        "views/Transactions → модалка новой операции",
        "AppProvider.addTransaction",
        "storageService.save (дебаунс)",
        "SqliteStorage.write → дифф по id → UPSERT (storage/schema.ts:upsertRowOp)",
        "SqliteSqlDriver.transaction: BEGIN → операции → COMMIT",
        "persist(): db.export() → SnapshotStore (IndexedDB / файл userData / localStorage)",
      ],
    },
    {
      id: "read-list",
      note: "Чтение списка операций.",
      steps: [
        "views/Transactions → useApp().data.transactions",
        "SqliteStorage.read → SELECT по таблицам коллекций",
        "storage/schema.ts: индексы по дате и категории",
        "normalize/merge документов → AppData в памяти",
        "фильтрация и постраничный slice в памяти",
      ],
    },
    {
      id: "capabilities-degrade",
      note: "Деградация под слабое устройство.",
      steps: [
        "useCapabilities → capabilities.detectCapabilities (RAM, ядра, reduced-motion)",
        "applyCapabilities → <html data-perf> / data-motion",
        "waapi.resolveMotionPlan → отключение переходов",
        "index.css: блоки html[data-perf=low] и html[data-motion=reduced]",
        "Settings: «Режим графики» показывает выбранный режим",
      ],
    },
    {
      id: "export-backup",
      note: "Резервная копия в файл.",
      steps: [
        "views/Settings → «Экспорт данных»",
        "lib/storage.ts: serializeExport",
        "PlatformBridge.saveFile (в Electron — диалог и запись файла, в web — download)",
      ],
    },
  ],
  taskHistory: [
    {
      task: "storage-migration",
      status: "done",
      note: "localStorage → SQLite (sql.js), миграция в одной транзакции, откат, снапшоты.",
      files: [
        "src/storage/types.ts",
        "src/storage/schema.ts",
        "src/storage/sqlite.ts",
        "src/storage/snapshots.ts",
        "src/storage/memory.ts",
        "src/storage/migrate.ts",
        "src/storage/index.ts",
        "src/lib/normalize.ts",
        "src/lib/storage.ts",
        "electron-main.cjs",
        "preload.cjs",
      ],
    },
    {
      task: "animation-delta-time",
      status: "done",
      note: "Ticker с delta-time, перевод width/top на transform, деградация по data-perf.",
      files: ["src/animations/ticker.ts", "src/animations/waapi.ts", "src/components/ui.tsx", "src/index.css"],
    },
    {
      task: "platform-bridges",
      status: "in-progress",
      note: "Контракты PlatformBridge и три моста готовы; Tauri/RN требуют внешнего тулчейна (Rust, Android SDK).",
      files: [
        "src/platform/types.ts",
        "src/platform/index.ts",
        "src/platform/webBridge.ts",
        "src/platform/windows/electronBridge.ts",
        "src/platform/android/capacitorBridge.ts",
        "src/platform/capabilities.ts",
      ],
    },
    {
      task: "subscriptions-deletion",
      status: "done",
      note: "Удаление операций из подписок больше не возвращает их к подтверждению; платежи следующего месяца не требуют подтверждения заранее.",
      files: ["src/lib/engine.ts", "src/hooks/AppProvider.tsx", "src/views/Payments.tsx", "src/views/Transactions.tsx", "tests/subscriptions.test.ts"],
    },
    {
      task: "project-map",
      status: "done",
      note: "Генератор карты: модули, символы, потоки данных, история задач.",
      files: ["map.config.ts", "scripts/generate-project-map.mjs", "project-map.json"],
    },
  ],
};

export default config;
