// Сверка трёх копий вёрстки: установщик Windows, ассеты Android-проекта и
// содержимое app.asar.
//
// Зачем: пользователю отдаются два разных файла — `Setup …exe` и `app-release.apk`.
// Если они собраны из разного кода, человек получит две разные программы под
// одним номером версии, и разбираться придётся уже у него.
//
// Ловушка, из-за которой проверка и написана: `scripts/build-android.mjs`
// сравнивал `dist/index.html` с его копией в ассетах по sha256 — и это
// сравнение всегда проходило, даже когда обе копии были устаревшими.
// Расхождение обнаружилось только здесь, при сравнении с app.asar.
//
// Пропущенные копии — не ошибка: до первой сборки Windows артефакта ещё нет.
// Ошибка — только когда копии есть и различаются.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { extractFile } from "@electron/asar";

const ROOT = process.cwd();
const ASAR = join(ROOT, "dist-electron", "win-unpacked", "resources", "app.asar");
const APK = join(ROOT, "android", "app", "build", "outputs", "apk", "release", "app-release.apk");

const short = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);

const copies = [];

const distPath = join(ROOT, "dist", "index.html");
if (existsSync(distPath)) {
  copies.push({ name: "dist/index.html (сборка vite)", buf: readFileSync(distPath) });
}

const androidPath = join(ROOT, "android", "app", "src", "main", "assets", "public", "index.html");
if (existsSync(androidPath)) {
  copies.push({ name: "android/assets/public/index.html (основа APK)", buf: readFileSync(androidPath) });
}

if (existsSync(ASAR)) {
  try {
    copies.push({ name: "app.asar (установщик Windows)", buf: extractFile(ASAR, "dist/index.html") });
  } catch (e) {
    console.log(`✗ не удалось прочитать app.asar: ${e.message.split("\n")[0]}`);
    process.exit(1);
  }
}

console.log("=".repeat(78));
console.log("Сверка копий вёрстки: одна и та же сборка должна попасть везде");
for (const c of copies) {
  console.log(`  ${short(c.buf)}  ${(c.buf.length / 1024 / 1024).toFixed(2)} МБ  ${c.name}`);
}
console.log("");

if (copies.length === 0) {
  console.log("· Копий нет — выполните `npm run build`. Проверять нечего.");
  process.exit(0);
}

if (copies.length === 1) {
  console.log(`· Копия одна (${copies[0].name}) — сверять не с чем. Постройте обе платформы.`);
  process.exit(0);
}

const first = copies[0];
const mismatched = copies.filter((c) => short(c.buf) !== short(first.buf));

if (mismatched.length === 0) {
  console.log(`✓ Все ${copies.length} копии совпадают побайтно (sha256 ${short(first.buf).slice(0, 16)}).`);
} else {
  console.log(`✗ Копии разошлись. Эталон — ${first.name}`);
  for (const c of mismatched) {
    console.log(`    ${c.name}: ${short(c.buf)} (${c.buf.length} байт)`);
  }
  console.log("");
  console.log("  Значит, артефакты собраны из разного кода. Причина почти всегда одна:");
  console.log("  сборка Android брала готовый `dist/`, а правка в `src/` уже была после него.");
  console.log("  Лечится пересборкой обеих платформ подряд:");
  console.log("      npm run build:apk && npm run build:win");
  console.log("  `scripts/build-android.mjs` теперь пересобирает вёрстку сам, если `dist/`");
  console.log("  старше исходников, — но старую сборку Windows пересобрать всё равно надо.");
  process.exit(1);
}

// Отдельно: APK должен быть не старше ассетов, из которых он собран.
// Gradle пересобирает APK не всегда, и на выходе может лежать пакет,
// собранный из прежней копии вёрстки с тем же именем.
if (copies.length > 1 && existsSync(APK)) {
  const androidCopy = copies.find((c) => c.name.includes("android"));
  if (androidCopy) {
    const apkTime = statSync(APK).mtimeMs;
    const assetsTime = statSync(androidPath).mtimeMs;
    console.log("");
    if (apkTime + 1000 < assetsTime) {
      console.log(`✗ APK старше ассетов, из которых он должен быть собран.`);
      console.log(`    app-release.apk     ${new Date(apkTime).toISOString()}`);
      console.log(`    assets/public/…     ${new Date(assetsTime).toISOString()}`);
      console.log("  Пересоберите APK: `npm run build:apk`.");
      process.exit(1);
    }
    console.log(`✓ app-release.apk не старше ассетов Android.`);
  }
}
