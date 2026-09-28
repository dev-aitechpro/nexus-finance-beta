#!/usr/bin/env node
// scripts/build-windows.mjs
// Сборка автономного установщика NEXUS Finance для Windows (NSIS) через
// electron-builder. Скрипт существует, чтобы сборка была повторяемой: нужные
// переменные окружения выставляются здесь, а не «по памяти» в консоли.
//
//   node scripts/build-windows.mjs              → установщик + portable
//   node scripts/build-windows.mjs --nsis-only  → только установщик
//
// Что делает скрипт и почему именно так:
//
// 1. Зеркало бинарей electron-builder. NSIS и rcedit в системе не стоят, кэш
//    electron-builder на этой машине пуст, а github.com недоступен, поэтому
//    ELECTRON_BUILDER_BINARIES_MIRROR указывает на зеркало npmmirror. Канонический
//    адрес electron-builder-binaries на этом зеркале:
//        https://registry.npmmirror.com/-/binary/electron-builder-binaries/<release>/<file>
//    Переопределяется переменной ELECTRON_BUILDER_BINARIES_MIRROR, если она уже
//    задана в окружении.
//
// 2. Electron берётся из node_modules/electron/dist (electronDist в ключе build),
//    поэтому скрипт НЕ качает electron-vX-win32-x64.zip заново: зеркала Electron
//    здесь отдают архив, но не SHASUMS256.txt, на котором @electron/get ломается.
//
// 3. Сборка идёт в два шага: сначала `vite build` (dist/index.html — вход для
//    electron-builder), затем electron-builder. Без первого шага в установщик
//    попадёт пустое окно.
//
// 4. Сеть здесь нестабильна: соединение рвётся на первой TLS-сессии, и
//    @electron/get не всегда успевает повторить запрос. Поэтому шаг с
//    electron-builder выполняется с несколькими попытками; кэш electron-builder
//    при этом переиспользуется, повторы стоят почти ничего.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_MIRROR = "https://registry.npmmirror.com/-/binary/electron-builder-binaries/";
const nsisOnly = process.argv.includes("--nsis-only");
const targets = nsisOnly ? ["nsis"] : ["nsis", "portable"];

const env = { ...process.env };
env.ELECTRON_BUILDER_BINARIES_MIRROR ||= DEFAULT_MIRROR;
// DEBUG=electron-builder кладёт рядом со сборкой builder-debug.yml с полным
// сгенерированным NSIS-скриптом: по нему видно, какая лицензия и какие
// страницы попали в установщик.
env.DEBUG ||= "electron-builder";

const run = (command, args, label) =>
  new Promise((resolve, reject) => {
    console.log(`\n▶ ${label}\n  ${command} ${args.join(" ")}`);
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${label}: код выхода ${code}`))));
  });

const withRetries = async (label, attempts, action) => {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await action();
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      console.warn(`\n⚠ ${label} не удался (${error.message}), попытка ${attempt}/${attempts} через 5 с…`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
};

const electronDist = path.join(root, "node_modules", "electron", "dist");
if (!existsSync(path.join(electronDist, "electron.exe"))) {
  console.error(
    `✗ Не найден распакованный Electron: ${electronDist}\n` +
      "  Выполните `npm install` (нужен запуск postinstall у пакета electron) — сборка идёт офлайн.",
  );
  process.exit(1);
}

try {
  await run("npm", ["run", "build"], "1/2 Сборка интерфейса (vite build → dist/)");
  await withRetries("Сборка electron-builder", 4, () =>
    run("npx", ["electron-builder", "--win", ...targets, "--x64"], `2/2 electron-builder (${targets.join(", ")})`),
  );
} catch (error) {
  console.error(`\n✗ ${error.message}`);
  process.exit(1);
}

const out = path.join(root, "dist-electron");
// Имена артефактов содержат версию, а версия живёт в package.json. Раньше имена
// были зашиты строкой, и сводка сборки радостно печатала «1.0.0» после того,
// как electron-builder давно собирал «1.0.0-beta.1»: выглядит как успех, а на
// деле сообщает не о том, что лежит в каталоге.
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const expected = [`NEXUS Finance Setup ${version}.exe`, `NEXUS Finance ${version}.exe`];

console.log(`\n✓ Готово. Артефакты в ${out}`);
for (const name of [...expected, "win-unpacked"]) {
  console.log(`  ${existsSync(path.join(out, name)) ? "✓" : "·"} ${name}`);
}

// Остатки прошлой сборки с другим номером версии. В релиз они не попадут —
// scripts/publish-release.mjs сверяет версию в имени и останавливается, — но
// занимают 200 МБ на диске и выглядят как свежие файлы.
const stray = readdirSync(out).filter((f) => f.endsWith(".exe") && !expected.includes(f));
if (stray.length > 0) {
  console.log(`  ⚠ в каталоге лежат сборки с другим номером версии (${version} в имени нет):`);
  for (const name of stray) console.log(`     ${name}`);
  console.log("     Их стоит удалить вручную.");
}
