// Проверка ссылок в документации.
//
// Зачем: документация растёт быстро, и относительные ссылки между файлами
// (`docs/Архитектура.md`, `license.txt`, `package.json`) портятся молча —
// в Markdown битая ссылка не выглядит ошибкой. Скрипт ловит это до сдачи.
//
// Проверяются две вещи, потому что документация ссылается на файлы двумя
// способами:
//   1. Ссылки и картинки в разметке: [текст](docs/Архитектура.md);
//   2. Упоминания в обратных кавычках: `src/storage/sqlite.ts:251` — их
//      в документации больше, чем ссылок, и именно они устаревают незаметно
//      (переименован скрипт, переехал файл, изменилось имя метода).
//
// Что проверяет:
//   • что файл или каталог по ссылке/упоминанию действительно есть;
//   • что якорь внутри целевого файла не ведёт в пустоту (мягкая проверка:
//     сверяем, что заголовок с таким текстом есть, и не ругаемся на полные
//     совпадения с экранированием);
//   • что в коде (``` ... ```) ничего не ищется: примеры кода не обязаны
//     быть рабочими ссылками.
//
// Внешние ссылки (http/https/mailto) не проверяются: сеть может быть
// недоступна, и отсутствие сети — не ошибка документации.
//
// Возвращает 0, если всё в порядке, и 1, если есть битые ссылки.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = process.cwd();
const DOC_FILES = ["README.md", ...collect("docs", ".md")];

function collect(dir, ext) {
  try {
    return readdirSync(join(ROOT, dir))
      .filter((name) => name.toLowerCase().endsWith(ext))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** Заголовки файла в нижнем регистре — для сверки якорей. */
function headingsOf(file) {
  try {
    return readFileSync(join(ROOT, file), "utf8")
      .split("\n")
      .filter((line) => /^#{1,6}\s/.test(line))
      .map((line) => line.replace(/^#{1,6}\s+/, "").trim().toLowerCase());
  } catch {
    return [];
  }
}

/** Слаги вида «## Проверка» -> «проверка» (упрощённый алгоритм GitHub). */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

const problems = [];
let checked = 0;
let mentioned = 0;

// Имена файлов проекта: относительные пути целиком и «хвосты» вида
// `windows/electronBridge.ts` — документация часто пишет путь относительно
// каталога-владельца, и это нужно уметь проверять.
const REPO_BASENESES = new Set();
const REPO_PATHS = new Set();
(function walk(dir, depth = 0) {
  if (depth > 6) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1);
    else {
      REPO_BASENESES.add(entry.name);
      REPO_PATHS.add(relative(ROOT, full).split(/[\\/]/).join("/"));
    }
  }
})(ROOT);

/** Совпадает ли упоминание с каким-либо файлом проекта по «хвосту» пути. */
function matchesRepoTail(bare) {
  if (REPO_PATHS.has(bare)) return true;
  const suffix = "/" + bare;
  for (const path of REPO_PATHS) if (path.endsWith(suffix)) return true;
  return false;
}

const PACKAGE_NAMES = new Set();
try {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  for (const field of [pkg.dependencies, pkg.devDependencies]) {
    for (const name of Object.keys(field ?? {})) PACKAGE_NAMES.add(name);
  }
} catch {
  /* package.json недоступен — просто пропустим пакеты */
}
// Пакеты из node_modules, которых нет в манифесте (транзитивные).
try {
  for (const name of readdirSync(join(ROOT, "node_modules"))) {
    if (!name.startsWith(".")) PACKAGE_NAMES.add(name);
  }
} catch {
  /* node_modules нет — не страшно */
}

// Вендоренные ассеты зависимостей: сканируем dist/ и корень пакетов —
// одного уровня вглубь достаточно, туда кладут wasm-обёртки и воркеры.
const VENDORED_ASSETS = new Set();
try {
  for (const pkg of readdirSync(join(ROOT, "node_modules"))) {
    if (pkg.startsWith(".")) continue;
    for (const sub of ["", "dist", "build"]) {
      const dir = sub ? join(ROOT, "node_modules", pkg, sub) : join(ROOT, "node_modules", pkg);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      for (const name of readdirSync(dir)) {
        if (statSync(join(dir, name)).isFile()) VENDORED_ASSETS.add(name);
      }
    }
  }
} catch {
  /* node_modules нет — не страшно */
}

/** Похоже ли слово на путь к файлу проекта, который имеет смысл проверять. */
const FILE_EXT = /\.(?:ts|tsx|cjs|mjs|js|jsx|json|md|html|css|ico|png|svg|txt|xml|gradle)$/i;
// Примеры имён в соглашениях и плейсхолдеры: их нельзя «проверить на存在».
const PLACEHOLDER = /PascalCase|camelCase|kebab-case|My[A-Z]\w*|Example|your[-_]|placeholder/i;
// Строка, где речь именно об отсутствии файла: «нет `gradlew`», «нужно
// добавить `capacitor.config.ts`». Такие упоминания не должны считаться ошибкой.
// ВНИМАНИЕ: здесь нельзя использовать \b — в JavaScript «символ слова» —
// только латиница и цифры, поэтому \bнет\b по кириллице не срабатывает никогда.
const ABSENCE_CONTEXT = /(^|[^А-Яа-яЁё])нет([^А-Яа-яЁё]|$)|не найден|отсутств|не существ|нужн|требуется|должен появиться|добав(ить|ать)|созда(ть|ётся)/i;

function looksLikePath(token) {
  if (token.length < 5 || token.length > 160) return false;
  if (/[*?<>|]/.test(token)) return false;          // glob-шаблоны и плейсхолдеры
  if (/…/.test(token)) return false;                 // многоточие: url(/…)
  if (/\bYYYY\b|\bXXX\b|\bTODO\b/.test(token)) return false; // шаблоны имён
  if (PLACEHOLDER.test(token)) return false;         // примеры в соглашениях
  if (token.includes(" ")) return false;             // фразы в кавычках
  if (/^[/'"]/.test(token)) return false;            // URL-пути и значения вида 'self'
  // убираем хвост с номерами строк: `electron-main.cjs:98-113`
  const bare = token.split(":")[0].replace(/[.,;)\]]+$/, "");
  if (bare.startsWith(".")) return false;            // `.cjs` — это расширение, а не файл
  if (!FILE_EXT.test(bare)) return false;
  // \w в JavaScript — только латиница, поэтому пути с кириллицей
  // (docs/Выполнение-ТЗ.md) через него не прошли бы. Явный класс символов.
  return /^[\p{L}\p{N}._\\/@-]+$/u.test(bare);
}

/** Упоминание в обратных кавычках: файл существует хоть в одном из корней,
 *  в которых автор мог иметь в виду файл. */
function findMentionedPath(doc, token) {
  const bare = token.split(":")[0].replace(/[.,;)\]]+$/, "");
  // Проверяем пакеты и вендоренные ассеты до слеша: у scoped-пакетов есть
  // «@scope/name», и там слеш есть.
  if (PACKAGE_NAMES.has(bare)) return bare;
  if (VENDORED_ASSETS.has(bare)) return bare;
  if (matchesRepoTail(bare)) return bare;

  const docDir = dirname(join(ROOT, doc));
  const roots = [docDir, ROOT, join(ROOT, "src"), join(ROOT, "tests"), join(ROOT, "scripts"), join(ROOT, "docs")];
  for (const base of roots) {
    const candidate = resolve(base, bare);
    if (existsSync(candidate)) return candidate;
  }
  if (!bare.includes("/") && REPO_BASENESES.has(bare)) return bare;
  return null;
}

for (const doc of DOC_FILES) {
  const abs = join(ROOT, doc);
  if (!existsSync(abs)) {
    problems.push({ doc, line: 0, text: doc, reason: "файл документации не найден" });
    continue;
  }
  const lines = readFileSync(abs, "utf8").split("\n");
  let inCode = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      return;
    }
    if (inCode) return;

    // 1) Ссылки в разметке
    const pattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    for (const match of line.matchAll(pattern)) {
      const target = match[1];
      if (/^(https?:|mailto:|tel:|data:)/i.test(target)) continue;
      if (target.startsWith("#")) {
        const slug = target.slice(1);
        if (!slug) continue;
        if (!headingsOf(doc).includes(slug.toLowerCase())) {
          problems.push({ doc, line: i + 1, text: target, reason: "якорь не найден в этом же файле" });
        }
        continue;
      }

      const [pathPart, anchor] = target.split("#");
      checked += 1;
      if (!pathPart) continue;
      const decoded = decodeURIComponent(pathPart);
      const targetPath = resolve(dirname(abs), decoded);
      const shown = relative(ROOT, targetPath) || decoded;

      if (!existsSync(targetPath)) {
        problems.push({ doc, line: i + 1, text: target, reason: `нет такого файла (${shown})` });
        continue;
      }
      // Ссылка на каталог без конкретного файла (например `docs/`) — это
      // осознанное решение автора, но читателю полезно знать, пусто ли там.
      if (statSync(targetPath).isDirectory() && readdirSync(targetPath).length === 0) {
        problems.push({ doc, line: i + 1, text: target, reason: `каталог пуст (${shown})` });
      }
      if (anchor && /\.(md|html)$/i.test(decoded)) {
        const slugs = headingsOf(shown.split(/[\\/]/).join("/"));
        if (slugs.length && !slugs.some((h) => slugify(h) === decodeURIComponent(anchor).toLowerCase())) {
          problems.push({
            doc,
            line: i + 1,
            text: target,
            reason: `якорь «${anchor}» не найден в ${shown}`,
          });
        }
      }
    }

    // 2) Упоминания файлов в обратных кавычках — самая частая форма в нашей
    // документации, и именно она устаревает молча. Ссылкой она не является,
    // поэтому считаем отдельно.
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const token = match[1].trim();
      if (!looksLikePath(token)) continue;
      // Упоминание файла в строке, где говорится об отсутствии или
      // необходимости добавить файл, — не ошибка, а предмет раздела
      // «чего нет в проекте». Иначе невозможно описать Android-проект,
      // которого у нас нет.
      if (ABSENCE_CONTEXT.test(line)) continue;
      mentioned += 1;
      if (!findMentionedPath(doc, token)) {
        problems.push({ doc, line: i + 1, text: token, reason: "упомянут файл, которого нет" });
      }
    }
  });
}

console.log("Проверка ссылок в документации");
console.log("=".repeat(78));
console.log(`Файлов: ${DOC_FILES.length} (${DOC_FILES.join(", ")})`);
console.log(`Проверено относительных ссылок: ${checked}`);
console.log(`Проверено упоминаний файлов в обратных кавычках: ${mentioned}`);
console.log("");

if (problems.length === 0) {
  console.log("✓ Битых ссылок нет.");
  process.exit(0);
}

for (const p of problems) {
  console.log(`✗ ${p.doc}:${p.line}  ${p.text}`);
  console.log(`    ${p.reason}`);
}
console.log("");
console.log(`Итого проблем: ${problems.length}`);
process.exit(1);
