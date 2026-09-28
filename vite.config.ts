import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { wasmInlinePlugin } from "./vite.shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Версия приложения читается из package.json — единственного места, где её
// и нужно менять при релизе.
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf8")) as { version: string };

// Политика безопасности содержимого для продакшен-сборки.
//
// Зачем: Electron ругается «Insecure Content-Security-Policy» — в документе не
// было политики вообще. Разрешаем ровно то, что приложению действительно нужно:
//   • 'unsafe-inline' в script-src — весь бандл лежит inline в index.html
//     (vite-plugin-singlefile), по-другому его не запустить;
//   • 'wasm-unsafe-eval' — sql.js компилирует WebAssembly, без этого токена
//     браузер блокирует компиляцию модуля;
//   • blob: и data: — воркер tesseract.js создаётся из blob-URL, wasm и
//     шрифты приходят как data:;
//   • cdn.jsdelivr.net — tesseract.js грузит воркер и языковые данные по сети
//     (см. scripts/check-file-protocol.mjs: других внешних загрузок нет).
//     Хост нужен в ДВУХ местах, и это не одно и то же:
//       - connect-src — за сами данные (wasm-ядро и *.traineddata) их грузит
//         сам воркер через fetch/XHR;
//       - script-src — tesseract.js создаёт воркер из blob:-URL, тело которого
//         `importScripts("https://cdn.jsdelivr.net/…/worker.min.js")`, а
//         importScripts внутри воркера проверяется по script-src унаследованной
//         им политики. Без хоста здесь воркер не стартует и распознавание чеков
//         падает с ошибкой загрузки — одинаково и под file://, и под схемой
//         Capacitor (https://localhost).
//     worker-src править не нужно: воркер создаётся из blob:, а он уже разрешён.
//   • api.github.com — кнопка «Проверить обновления» на Android и в браузере
//     спрашивает GitHub Releases API, и без хоста здесь запрос упирается в
//     политику безопасности: пользователь увидел бы «запрос заблокирован»
//     вместо ответа. На Windows проверку делает главный процесс Electron, он
//     CSP не подчиняется, — хост нужен именно для WebView-контейнера.
//     Открытие страницы релиза в браузере CSP не касается: это переход
//     наружу, а не запрос из приложения.
//   • file: — под file:// (именно так грузит Electron) origin 'self' не
//     совпадает с файловыми URL, поэтому нужен явный file:.
//
// Плагин только для build: в dev-режиме политика сломала бы HMR-клиент Vite.
const CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "script-src 'unsafe-inline' 'wasm-unsafe-eval' data: blob: file: https://cdn.jsdelivr.net",
  "style-src 'unsafe-inline' data: file:",
  "img-src 'self' data: blob: file:",
  "font-src 'self' data: file:",
  "media-src 'self' data: blob: file:",
  "connect-src 'self' data: blob: file: https://cdn.jsdelivr.net https://api.github.com",
  "worker-src 'self' blob: data:",
  "frame-src 'self' blob: data:",
].join('; ');

const cspPlugin = (): Plugin => ({
  name: "nexus-csp",
  apply: "build",
  transformIndexHtml: {
    order: "post",
    handler: (html) => ({
      html,
      tags: [{
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: CSP },
        injectTo: "head-prepend",
      }],
    }),
  },
});

export default defineConfig({
  // Относительная база. Сейчас её попутно выставляет viteSingleFile, но
  // полагаться на побочный эффект чужого плагина нельзя: стоит отключить
  // single-file (или добавить ассет, который не вшивается) — и абсолютный
  // base уведёт ссылки от корня диска, что ломает и file:// в Electron,
  // и WebView контейнера Capacitor (https://localhost). С relative base любой
  // путь резолвится от каталога документа, где бы документ ни лежал.
  base: "./",
  plugins: [wasmInlinePlugin(), react(), tailwindcss(), viteSingleFile(), cspPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  define: {
    'process.env': {},
    'global': 'globalThis',
    // Версия подставляется из package.json, чтобы источник правды был один.
    // Раньше версия была ещё и строкой в src/lib/constants.ts, из-за чего
    // установщик и экран настроек показывали разные версии.
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
  optimizeDeps: {
    exclude: ['electron', 'fs', 'path', 'child_process'],
  },
  build: {
    rollupOptions: {
      // ⚠️ Node-модули нельзя объявлять external в браузерной сборке: в бандл
      // попадает голый `import "fs"`, и страница падает при загрузке с ошибкой
      // «Failed to resolve module specifier "fs"». Вместо этого Vite подставляет
      // безопасные заглушки, которые бросают ошибку только при реальном обращении
      // (например, sql.js трогает fs только в node-ветке, которая в браузере не
      // выполняется). Основной процесс Electron — отдельные .cjs-файлы и в эту
      // сборку не входят.
      input: {
        // Для пользователей: main.tsx (без DevTools)
        main: path.resolve(__dirname, 'index.html'),
      },
    },
  },
});