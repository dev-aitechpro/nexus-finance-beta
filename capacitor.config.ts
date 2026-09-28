// capacitor.config.ts
// Конфигурация сборки Android-версии. Основная часть правок этого файла
// делается в ходе настройки Android-сборки, здесь — исходные значения.
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  // Идентификатор приложения: тот же, что у установщика Windows
  // (package.json -> build.appId), чтобы одна сущность, одна марка.
  appId: "com.nexus.finance",
  appName: "NEXUS Finance",
  // Куда capacitor sync кладёт собранный рендерер.
  webDir: "dist",
  server: {
    // Схема https вместо http: Capacitor по умолчанию так и делает, и это
    // даёт приложению secure context (нужен для камеры и IndexedDB).
    androidScheme: "https",
    // Рендерер грузится с https://localhost — это origin документа, к которому
    // привязано `'self'` в CSP из vite.config.ts. Менять хост без нужды нельзя:
    // политика и все относительные пути в сборке рассчитаны на этот origin.
    hostname: "localhost",
  },
  android: {
    // Смешанное содержимое (http внутри https) не нужно и небезопасно.
    allowMixedContent: false,
  },
  plugins: {
    App: {
      // ⚠️ Здесь должно остаться false (значение по умолчанию), и это не
      // «не настроено», а требование: при disableBackButtonHandler = true
      // нативный AppPlugin вообще не создаёт OnBackPressedCallback, и кнопка
      // «Назад» перестаёт доходить до JS — вместе с ней и логика
      // «закрыть модалку / вернуться на главный экран» из
      // src/hooks/usePlatformBackButton.ts.
      disableBackButtonHandler: false,
    },
    SystemBars: {
      // Задано явно, а не «по умолчанию». От этого значения зависит вёрстка:
      // в режиме "css" Capacitor не падит WebView нативно, а отдаёт значения
      // в CSS-переменные и env(safe-area-inset-*), которые читает src/index.css
      // (--sat/--sar/--sab/--sal). Смена значения по умолчанию в новой версии
      // Capacitor тихо сломала бы отступы на телефоне, поэтому фиксируем
      // намерение в конфиге, а не полагаемся на дефолт.
      insetsHandling: "css",
    },
  },
};

export default config;
