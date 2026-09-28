// Проверка: модуль обновления действительно попадёт в сборку.
//
// electron-builder по умолчанию не кладёт в установленное приложение
// node_modules — сборка получается «пустой»: в app.asar лежат только наш код
// и вёрстка. Для most-приложения это нормально, но здесь в главном процессе
// есть `require("electron-updater")`, и без зависимостей обновление не
// работает: модуль не найден, а пользователь видит ошибку вместо кнопки.
//
// Поэтому в build.files перечислены конкретные пакеты: сам обновлятор и всё,
// что он тянет за собой (16 пакетов, ~2,2 МБ). Список нельзя оставлять на
// память: обновление electron-updater меняет его состав, и забытый пакет
// проявится только у пользователя после установки. Эта проверка ловит
// расхождение на этапе сборки, до публикации.
//
// Что проверяем:
//   1. electron-updater объявлен зависимостью приложения;
//   2. каждый пакет из транзитивного замыкания перечислен в build.files;
//   3. каждый перечисленный пакет реально нужен (нет «осиротевших» записей);
//   4. каждый перечисленный пакет существует в node_modules (нет опечатки).
//
// Код возврата 0, если всё в порядке, и 1, если есть расхождения.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const UPDATER = "electron-updater";
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const files = pkg.build?.files ?? [];

// 1. обновлятель должен быть в зависимостях, а не только в devDependencies:
// только production-зависимости имеет смысл возить с собой.
const inDeps = pkg.dependencies?.[UPDATER];
const inDevDeps = pkg.devDependencies?.[UPDATER];
if (!inDeps) {
  console.log(`✗ ${UPDATER} не объявлен в dependencies`);
  if (inDevDeps) {
    console.log(`  Сейчас он в devDependencies (${inDevDeps}) — в установленное`);
    console.log("  приложение devDependencies не попадают никогда.");
  }
  console.log(`  Исправление: npm install --save ${UPDATER}`);
  process.exit(1);
}

// 2. Транзитивное замыкание по dependencies. optionalDependencies не
//    разворачиваем: electron-updater тянет их через extract-zip/yauzl, а
//    установщик NSIS они не нужны, и в бандле им не место.
const closure = new Set();
const visit = (name) => {
  if (closure.has(name)) return;
  closure.add(name);
  const manifest = join(ROOT, "node_modules", name, "package.json");
  if (!existsSync(manifest)) return;
  const deps = JSON.parse(readFileSync(manifest, "utf8")).dependencies ?? {};
  for (const dep of Object.keys(deps)) visit(dep);
};
visit(UPDATER);

// Что реально разрешено в сборку.
const listed = new Set();
for (const pattern of files) {
  const m = /^node_modules\/(.+)\/\*\*\/\*$/.exec(pattern);
  if (m) listed.add(m[1]);
}

const problems = [];

for (const name of [...closure].sort()) {
  if (!listed.has(name)) {
    problems.push({
      kind: "нет в build.files",
      text: `node_modules/${name}/**/*`,
      why: `${UPDATER} требует этот пакет, но он не попадёт в app.asar — обновление упадёт с «Cannot find module»`,
    });
  }
  if (!existsSync(join(ROOT, "node_modules", name))) {
    problems.push({
      kind: "нет на диске",
      text: `node_modules/${name}`,
      why: "пакет указан в build.files, но не установлен — вероятно, опечатка в имени",
    });
  }
}

for (const name of [...listed].sort()) {
  if (!closure.has(name)) {
    problems.push({
      kind: "лишний в build.files",
      text: `node_modules/${name}/**/*`,
      why: "обновлятель этот пакет не тянет — запись увеличивает сборку без нужды",
    });
  }
}

console.log("=".repeat(78));
console.log(`Проверка поставки модуля обновления (${UPDATER} ${inDeps})`);
console.log(`Пакетов в транзитивном замыкании: ${closure.size}`);
console.log(`Пропущено в build.files: ${listed.size}`);
console.log("");

if (problems.length === 0) {
  console.log("✓ Список в build.files совпадает с зависимостями обновлятеля.");
  process.exit(0);
}

for (const p of problems) {
  console.log(`✗ ${p.kind}: ${p.text}`);
  console.log(`    ${p.why}`);
}
console.log("");
console.log(`Проблем найдено: ${problems.length}`);
process.exit(1);
