#!/usr/bin/env node
// scripts/check-dist.mjs
// Проверка собранного артефакта dist/index.html.
//
// Ловит ровно тот класс дефектов, который ломал релиз: голые импорты
// node-модулей в браузерном бандле (`import "fs"`) из-за rollupOptions.external.
// В dev-сервере такое скрыто заглушками Vite, а в собранном single-file
// страница падает на загрузке с «Failed to resolve module specifier "fs"».
//
// Запуск: node scripts/check-dist.mjs  (или npm run verify)
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const target = path.join(root, "dist", "index.html");

/** node-модули, которых не должно остаться в браузерном бандле */
const NODE_BUILTINS = ["fs", "path", "child_process", "electron", "os", "crypto", "net", "http"];

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`✓ ${msg}`);

let html;
try {
  const info = await stat(target);
  html = await readFile(target, "utf8");
  ok(`dist/index.html найден (${(info.size / 1024 / 1024).toFixed(2)} МБ)`);
} catch {
  fail("dist/index.html не найден — сначала выполните `npm run build`");
  process.exit(1);
}

const bare = [];
for (const mod of NODE_BUILTINS) {
  // static import, dynamic import и export ... from в минифицированном виде
  const patterns = [
    `import"${mod}"`,
    `import'${mod}'`,
    `from"${mod}"`,
    `from'${mod}'`,
    `import("${mod}")`,
    `import('${mod}')`,
  ];
  if (patterns.some((p) => html.includes(p))) bare.push(mod);
}
if (bare.length) {
  fail(`в бандле остались импорты node-модулей: ${bare.join(", ")} — страница упадёт в браузере`);
} else {
  ok("голых импортов node-модулей нет");
}

if (html.includes("<title>NEXUS Finance</title>")) ok("заголовок страницы на месте");
else fail("в index.html нет ожидаемого <title>");

// Признак single-file сборки: ни одного внешнего <script src> / <link rel=stylesheet>.
// Иконка и прочие статические файлы допустимы — важно лишь, чтобы они были
// физически в dist (иначе будет 404 в консоли).
const references = [...html.matchAll(/<(?:script[^>]+src|link[^>]+href)\s*=\s*["']([^"']+)["']/g)].map(
  (m) => m[1],
);
const codeAssets = references.filter((url) => /\.m?js(?:[?#]|$)/.test(url) || /\.css(?:[?#]|$)/.test(url));
const localAssets = references.filter((url) => !/^(https?:|data:|#)/.test(url));

const missingAssets = [];
for (const url of localAssets) {
  const file = path.join(root, "dist", url.replace(/^\.?\//, "").split(/[?#]/)[0]);
  try {
    await stat(file);
  } catch {
    missingAssets.push(url);
  }
}

if (codeAssets.length) {
  fail(`index.html всё ещё подключает отдельные js/css (не single-file): ${codeAssets.join(", ")}`);
} else {
  ok("js и css встроены в index.html");
}
if (missingAssets.length) {
  fail(`index.html ссылается на отсутствующие файлы: ${missingAssets.join(", ")}`);
} else if (localAssets.length) {
  ok(`статические файлы на месте: ${localAssets.join(", ")}`);
}

if (process.exitCode) {
  console.error("\nПроверка не пройдена.");
} else {
  console.log("\nАртефакт готов к раздаче.");
}
