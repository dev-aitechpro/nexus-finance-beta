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
import { existsSync, readFileSync } from "node:fs";
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

// Отдельно: APK должен содержать тот же бандл, что и dist.
//
// Сначала здесь стояло сравнение по времени файлов, и оно врубалось ложно:
// время меняется и от `cap sync` (перезаписывает файл тем же содержимым), и
// просто от того, что файл тронули. Пришлось выяснять это по готовому APK.
//
// Поэтому сравниваем содержимое: APK — это zip, и нужная запись читается из
// него напрямую. Зависимость не нужна: формат zip разбирается вручную по
// central directory, а распаковка — zlib.inflateRawSync из стандартной
// библиотеки.
import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** Достать запись zip-архива по точному имени; null, если записи нет. */
const readZipEntry = (zip, wanted) => {
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0 && i > zip.length - 65_536; i -= 1) {
    if (zip.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: не найден End of Central Directory");

  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;
    const nameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLen);
    if (name === wanted) {
      const nameLenLocal = zip.readUInt16LE(localOffset + 26);
      const extraLenLocal = zip.readUInt16LE(localOffset + 28);
      const method = zip.readUInt16LE(localOffset + 8);
      const compressedSize = zip.readUInt32LE(localOffset + 18);
      const start = localOffset + 30 + nameLenLocal + extraLenLocal;
      const raw = zip.subarray(start, start + compressedSize);
      return method === 0 ? raw : inflateRawSync(raw);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
};

if (copies.length > 1 && existsSync(APK)) {
  const distCopy = copies[0];
  try {
    const inside = readZipEntry(readFileSync(APK), "assets/public/index.html");
    console.log("");
    if (inside === null) {
      console.log(`✗ в APK нет assets/public/index.html — пакет собран не из того, что проверяем.`);
      process.exit(1);
    }
    // distCopy — это запись { name, buf }; хэш считается по buf.
    if (short(inside) === short(distCopy.buf)) {
      console.log(`✓ внутри app-release.apk тот же бандл (sha256 ${short(distCopy.buf).slice(0, 16)}).`);
    } else {
      console.log(`✗ внутри app-release.apk другой бандл.`);
      console.log(`    APK  sha256 ${short(inside)} (${inside.length} байт)`);
      console.log(`    dist sha256 ${short(distCopy.buf)} (${distCopy.buf.length} байт)`);
      console.log("  Пересоберите APK: `npm run build:apk`.");
      process.exit(1);
    }
  } catch (e) {
    console.log("");
    console.log(`✗ не удалось прочитать APK как zip: ${e.message}`);
    process.exit(1);
  }
}
