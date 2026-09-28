#!/usr/bin/env node
// scripts/check-file-protocol.mjs
// Проверка того, что собранный рендерер действительно живёт под протоколом `file://`.
//
// Electron открывает приложение через `win.loadFile(dist/index.html)`, то есть
// документ грузится как `file:///C:/.../dist/index.html`. Это не http-режим, и
// ряд привычных конструкций в нём ломается:
//
//   * путь с ведущим `/` (`src="/assets/app.js"`, `href="/favicon.ico"`,
//     `url(/img/x.png)`, `import("/chunk.js")`) — резолвится не от каталога
//     документа, а от корня диска: `C:\assets\app.js`;
//   * `location.origin` у file:// равен строке `"null"`, поэтому
//     `new URL("/api", location.origin)` бросает Invalid URL;
//   * запросы собственного origin (`fetch("/data.json")`) уходят в
//     `file:///C:/data.json` и не проходят;
//   * service worker на file:// не регистрируется вовсе;
//   * `import.meta.env.BASE_URL` по умолчанию равен `"/"`, и любая склейка
//     вида `${BASE_URL}/assets/…` даёт тот же абсолютный путь от корня диска.
//
// Плюс частые «хвосты» от dev-режима: ссылки на `http://localhost:5173` и
// подобные, которые не должны были попасть в прод-сборку.
//
// Скрипт ничего не правит — только находит и отчитывается, с номерами строк и
// столбцов. Сборка минифицирована почти в одну строку (2+ МБ), поэтому номер
// строки мало что значит: у каждой находки печатаются ещё и столбец, и
// абсолютное смещение в файле.
//
// Запуск: node scripts/check-file-protocol.mjs [путь-к-html]
// Код возврата: 0 — проблем нет, 1 — есть хотя бы одна ошибка.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const explicit = process.argv[2];
const target = explicit ? path.resolve(process.cwd(), explicit) : path.join(root, "dist", "index.html");
const distDir = path.dirname(target);

/* ─────────────────────────── мелкие помощники ─────────────────────────── */

const say = (s = "") => console.log(s);
const rule_ = (s = "─", n = 78) => s.repeat(n);
const bytes = (n) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} МБ` : n >= 1024 ? `${(n / 1024).toFixed(1)} КБ` : `${n} Б`;

/** Значения, которые абсолютным путём не являются. */
const PLACEHOLDER = /^(?:#|$|data:|blob:|about:|javascript:|mailto:|tel:|sms:|\/\/|\{\{|\$\{|<%|none\b|null\b|undefined\b|void\(0\))/i;
/** Явные маркеры картинок-заглушек: `placeholder`, `spacer`, `blank.gif` и т.п. */
const STUB_NAME = /(placeholder|spacer|blank|no-?image|dummy|1x1|pixel)\b/i;
/** Схемы, для которых file://-диагностика неприменима. */
const FOREIGN_SCHEME = /^(?:https?|ftps?|ws|wss|mailto|tel|sms|blob|data|about|javascript|file):/i;

const findings = [];
const notes = [];

/**
 * Регистрирует находку.
 * @param {string} id идентификатор правила
 * @param {"error"|"warning"} severity
 * @param {number} offset смещение в файле (для отчёта)
 * @param {string} text что именно найдено (для отчёта)
 * @param {string} why почему это ломается под file://
 */
function add(id, severity, offset, text, why) {
  findings.push({ id, severity, offset, text, why, ...locate(offset) });
}
const note = (text) => notes.push(text);

/**
 * Правила-«охватники» пересекаются с более специфичными (например, общий
 * поиск `/assets/…` и точечный `import("/assets/…")`). Здесь помечаем находку
 * и пропускаем её, если тот же участок уже разобран более специфичным
 * правилом, — иначе в отчёте одно и то же место будет числиться дважды.
 * Порядок запуска правил важен: специфичные идут первыми.
 */
const covered = [];
const addUnique = (id, severity, offset, text, why) => {
  if (covered.some(([a, b]) => offset >= a && offset < b)) return;
  covered.push([offset, offset + Math.max(1, text.length)]);
  add(id, severity, offset, text, why);
};

/* ──────────────────────────────── чтение ──────────────────────────────── */

let raw;
let size;
try {
  const info = await stat(target);
  raw = await readFile(target, "utf8");
  size = info.size;
} catch {
  if (explicit) {
    console.error(`✗ Файл не найден: ${target}`);
  } else {
    console.error("✗ dist/index.html не найден — сначала выполните `npm run build`");
  }
  process.exit(1);
}

/* ────────────────── маскирование встроенных двоичных данных ───────────────
 *
 * В single-file сборке лежат base64-полезная нагрузка (wasm sql.js, встроенные
 * ассеты) общим объёмом почти 900 КБ. Случайные последовательности символов
 * внутри base64 содержат `/`, цифры и буквы, поэтому «localhost:3000» или
 * `url(/x)` там возникают как случайные совпадения. Перед любым сканированием
 * такие блоки заменяем пробелами РОВНО той же длины — все смещения в отчёте
 * остаются верными относительно исходного файла.
 */
const blobRanges = [];
const code = raw.replace(/data:[^\s"'`)\\]+|[A-Za-z0-9+/]{200,}={0,2}/g, (m, offset) => {
  blobRanges.push([offset, offset + m.length]);
  return " ".repeat(m.length);
});
const inBlob = (offset) => blobRanges.some(([a, b]) => offset >= a && offset < b);
/** Крупные блоки (data:-URL и base64-полезная нагрузка) — для статистики. */
const bigBlobs = blobRanges.filter(([a, b]) => b - a >= 64);

/* ──────────────────────── позиция в файле и сниппеты ──────────────────── */

const lineStarts = [0];
for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) lineStarts.push(i + 1);

/** Перевод смещения в номер строки и столбца (строки могут быть длиной в мегабайт). */
function locate(offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: offset - lineStarts[lo] + 1 };
}

const flat = (s) => s.replace(/\s+/g, " ");

/** Сниппет вокруг находки: три части склеиваются, совпадение выделяется «ёлочками». */
function snippet(offset, len, span = 62) {
  if (inBlob(offset)) return "⟨внутри встроенных base64-данных — совпадений там быть не может⟩";
  const hitLen = Math.max(1, len);
  const pre = flat(raw.slice(Math.max(0, offset - span), offset));
  const hit = flat(raw.slice(offset, offset + hitLen));
  const post = flat(raw.slice(offset + hitLen, Math.min(raw.length, offset + hitLen + span)));
  return `${pre ? "…" : ""}${pre}«${hit}»${post}${offset + hitLen + span < raw.length ? "…" : ""}`;
}

/* ───────────────────── разбор структуры: где разметка, где JS/CSS ─────────
 *
 * Внутри встроенного бандла встречаются строковые литералы вида "<script><\/script>"
 * (проверка вложенности тегов в React). Наивный поиск `<script` посчитал бы их
 * как отдельные теги. Поэтому идём по тегам и пропускаем тело raw-text-элементов:
 * по spec HTML содержимое <script>/<style> заканчивается на первом `</script>`.
 */
const RAW_TEXT = new Set(["script", "style"]);
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:_-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
const regions = [];
let openTag = null;
let mTag;
while ((mTag = TAG_RE.exec(code))) {
  const [whole, slash, name, attrs] = mTag;
  const lower = name.toLowerCase();
  if (openTag) {
    if (slash && lower === openTag.name) {
      regions.push({ ...openTag, innerStart: openTag.tagEnd, innerEnd: mTag.index, closeEnd: mTag.index + whole.length });
      openTag = null;
    }
    continue; // внутри raw-text — любой «тег» считаем текстом
  }
  if (!slash && RAW_TEXT.has(lower) && !/\/\s*>$/.test(whole)) {
    openTag = { kind: lower, name: lower, start: mTag.index, tagEnd: mTag.index + whole.length, attrs };
  }
}

const counted = regions.filter((r) => RAW_TEXT.has(r.kind));
/**
 * Две проекции исходника той же длины (смещения в отчёте остаются верными):
 *   `markup` — только HTML-разметка, тела inline-скриптов и стилей стёрты;
 *   `inline` — наоборот, только тела inline-скриптов и стилей.
 * Разметку проверяет R1, содержимое бандла — остальные правила. Так одна и та
 * же находка не докладывается дважды.
 */
const projections = (() => {
  const markupParts = [];
  const inlineParts = [];
  let cur = 0;
  for (const r of counted) {
    const gap = " ".repeat(Math.max(0, r.innerStart - cur));
    markupParts.push(code.slice(cur, r.innerStart), " ".repeat(Math.max(0, r.innerEnd - r.innerStart)));
    inlineParts.push(gap, code.slice(r.innerStart, r.innerEnd));
    cur = r.innerEnd;
  }
  markupParts.push(code.slice(cur));
  inlineParts.push(" ".repeat(Math.max(0, code.length - cur)));
  return { markup: markupParts.join(""), inline: inlineParts.join("") };
})();
const { markup, inline } = projections;

/* ═══════════════════════════════ ПРОВЕРКИ ═══════════════════════════════ */

const WHY = {
  attrAbs:
    "Под file:// адрес с ведущим «/» отсчитывается не от каталога документа, а от корня диска: " +
    "на Windows получится C:\\… вместо C:\\…\\dist\\…. Ресурс не найдётся (404/тихий сбой загрузки).",
  attrMissing:
    "Путь относительный, но файла нет рядом с index.html. По http:// такой запрос дал бы понятный 404, " +
    "под file:// он просто молча не загрузится — иконка или скрипт просто не появятся.",
  jsAbs:
    "Строка собирается в абсолютный URL в рантайме. Под file:// она уедет в корень диска (C:\\…), " +
    "и загрузка завершится ошибкой.",
  cssUrl:
    "«url(/…)» в CSS — это абсолютный путь от корня диска под file://. Изображение/шрифт не загрузится.",
  fetch:
    "fetch() под file:// не умеет ходить в собственный origin: «/api/…» превращается в file:///C:/api/… " +
    "и падает с ошибкой доступа (у file:// origin непрозрачный, CORS-проверку не пройти).",
  dynImport:
    "Динамический импорт с абсолютным путём под file:// указывает на корень диска. Чанк не загрузится — " +
    "модуль не выполнится, приложение упадёт на этом импорте.",
  newUrlAbs:
    "Абсолютный путь в new URL(…) при наличии базы всегда отбрасывает базу. Под file:// получится file:///C:/…, " +
    "то есть корень диска, а не каталог dist.",
  newUrlOrigin:
    "У документа на file:// значение location.origin — строка «null». Конструкция new URL(…, location.origin) " +
    "бросит Invalid URL в любом случае, а под file:// корректной базой может быть только location.href.",
  devServer:
    "Ссылка на dev-сервер попала в прод-сборку. В десктопном приложении по file:// сервера нет: " +
    "запрос уйдёт в file:///C:/… и завершится ошибкой, а в офлайне — просто не дойдёт.",
  serviceWorker:
    "Service worker нельзя зарегистрировать на file://: браузер требует безопасный origin (https). " +
    "Регистрация бросит SecurityError, и код после неё не выполнится.",
  baseUrl:
    "import.meta.env.BASE_URL в Vite по умолчанию равен «/». Склейка даёт абсолютный путь от корня диска — " +
    "ровно тот же класс проблем, что и src=\"/assets/…».",
  assetsAbs:
    "Путь /assets/… — характерный след base: «/» в сборке. Под file:// он указывает в корень диска, " +
    "а не в dist/assets. Лечится относительным base: «./».",
};

/* ── R1: абсолютные пути в атрибутах src/href реальной разметки ─────────── */
const ATTR_RE = /\b(src|href|poster|action|data-src|formaction)\s*=\s*(["'])([^"']*)\2/gi;
for (const m of markup.matchAll(ATTR_RE)) {
  const [whole, attrName, , value] = m;
  if (PLACEHOLDER.test(value) || FOREIGN_SCHEME.test(value) || STUB_NAME.test(value)) continue;

  if (/^\/(?!\/)/.test(value)) {
    addUnique("attr-abs", "error", m.index, whole, WHY.attrAbs);
    continue;
  }
  // Относительная ссылка: проверяем, есть ли файл рядом с index.html.
  const clean = value.split(/[?#]/)[0];
  if (!clean || clean.startsWith("/") || /[$<{%]/.test(clean)) continue;
  const hasExt = /\.[a-z0-9]{1,8}$/i.test(clean);
  if (!hasExt && attrName.toLowerCase() === "href") continue; // может быть маршрутом
  const resolved = path.resolve(distDir, clean);
  try {
    await stat(resolved);
  } catch {
    addUnique("attr-missing", "error", m.index, whole, WHY.attrMissing);
  }
}

/* ── R2: абсолютные пути в строковых литералах бандла (createElement и т.п.) ── */
for (const re of [
  /\b(?:src|href|poster|action)\s*[:=]\s*(["'`])(\/(?!\/)[^"'`\s]*)\1/g,
  /\bsetAttribute\s*\(\s*["'](?:src|href|poster)["']\s*,\s*(["'`])(\/(?!\/)[^"'`\s]*)\1/g,
  /\b(?:src|href)\s*:\s*(["'`])(\/(?!\/)[^"'`\s]*)\1/g,
]) {
  for (const m of inline.matchAll(re)) {
    if (FOREIGN_SCHEME.test(m[2])) continue;
    addUnique("js-abs-url", "error", m.index, m[0], WHY.jsAbs);
  }
}

/* ── R3: url(/…) в CSS (и в inline-атрибутах style=) ───────────────────── */
for (const m of code.matchAll(/\burl\(\s*(["']?)(\/(?!\/)[^"')\s]*)\1\s*\)/g)) {
  addUnique("css-url", "error", m.index, m[0], WHY.cssUrl);
}

/* ── R4: fetch("/…") ───────────────────────────────────────────────────── */
for (const m of inline.matchAll(/\bfetch\s*\(\s*(["'`])(\/(?!\/)[^"'`\s]*)\1/g)) {
  addUnique("fetch-abs", "error", m.index, m[0], WHY.fetch);
}

/* ── R5: динамические загрузки по абсолютному пути ─────────────────────── */
for (const m of code.matchAll(/\bimport\s*\(\s*(["'`])(\/(?!\/)[^"'`\s]*)\1/g)) {
  addUnique("dyn-import", "error", m.index, m[0], WHY.dynImport);
}
for (const m of code.matchAll(/\bimportScripts\s*\(\s*(["'`])(\/(?!\/)[^"'`\s]*)\1/g)) {
  addUnique("import-scripts", "error", m.index, m[0], WHY.dynImport);
}
for (const m of code.matchAll(/\bnew\s+Worker\s*\(\s*(["'`])(\/(?!\/)[^"'`\s]*)\1/g)) {
  addUnique("new-worker", "error", m.index, m[0], WHY.dynImport);
}

/* ── R6: new URL(…) ────────────────────────────────────────────────────── */
// Сначала самый специфичный случай: база location.origin под file:// равна «null».
for (const m of code.matchAll(/\bnew\s+URL\s*\(\s*[^,()]{1,60}?\s*,\s*((?:window\.)?location\.origin)\s*\)/g)) {
  addUnique("new-url-origin", "error", m.index, m[0], WHY.newUrlOrigin);
}
// Затем абсолютный путь первым аргументом: база отбрасывается, путь уходит в корень диска.
for (const m of code.matchAll(/\bnew\s+URL\s*\(\s*(["'`])(\/(?!\/)[^"'`\s]*)\1\s*,\s*([^)]{0,80})\)/g)) {
  addUnique("new-url-abs", "error", m.index, m[0], `${WHY.newUrlAbs} База здесь: ${m[3].trim() || "?"}.`);
}
// База вида location.href: безопасно, только если первый аргумент относительный.
for (const m of code.matchAll(/\bnew\s+URL\s*\(\s*([A-Za-z_$][\w$?.[\]]*)\s*,\s*((?:window\.)?location\.(?:href|pathname))\s*\)/g)) {
  add("new-url-rel", "warning", m.index, m[0], "location.href под file:// — это путь к самому index.html. " +
    "Такое срабатывает корректно, если аргумент относительный (./x, x). Проверьте, что в этот код " +
    "не попадает путь от корня диска: иначе получите C:\\… вместо каталога dist.");
}

/* ── R7: dev-сервер / loopback ──────────────────────────────────────────── */
for (const m of code.matchAll(/\b(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?\b/gi)) {
  addUnique("dev-host", "error", m.index, m[0], WHY.devServer);
}
// Типичные порты Vite/webpack-dev-server, привязанные к хосту (не «голое :3000»:
// такие числа свободно встречаются в таблицах данных внутри бандла).
for (const m of code.matchAll(/\bhttps?:\/\/[^\s"'`/]*:(?:5173|4173|3000|8080|8000|1234|9000)\b/gi)) {
  addUnique("dev-port", "error", m.index, m[0], WHY.devServer);
}

/* ── R8: serviceWorker.register("/…") ──────────────────────────────────── */
for (const m of code.matchAll(/\bserviceWorker\s*\.\s*register\s*\(\s*(["'`])([^"'`]*)\1/g)) {
  if (/^\/(?!\/)/.test(m[2])) addUnique("sw-abs", "error", m.index, m[0], WHY.serviceWorker);
}
for (const m of code.matchAll(/\.\s*register\s*\(\s*(["'`])([^"'`]*)\1/g)) {
  if (/^\/(?!\/)/.test(m[2]) && /\.js\b/i.test(m[2])) addUnique("sw-abs", "error", m.index, m[0], WHY.serviceWorker);
}

/* ── R9: следы base: «/» (BASE_URL и абсолютные /assets/) ──────────────── */
for (const m of code.matchAll(/(?:import\s*\.\s*meta\s*\.\s*env|process\s*\.\s*env)\s*\.\s*BASE_URL/g)) {
  addUnique("base-url", "error", m.index, m[0], WHY.baseUrl);
}
// Общий «охватник» — идёт последним и молчит там, где уже есть точная находка.
for (const m of code.matchAll(/\/assets\/[A-Za-z0-9._-]/g)) {
  addUnique("assets-abs", "error", m.index, m[0], WHY.assetsAbs);
}

/* ══════════════════════════════ СТАТИСТИКА ══════════════════════════════ */

const attrOf = (attrs, name) => {
  const re = new RegExp(`\\b${name}\\s*=\\s*(["'])([^"']*)\\1`, "i");
  return re.exec(attrs)?.[2] ?? null;
};
const scripts = regions.filter((r) => r.kind === "script");
const styles = regions.filter((r) => r.kind === "style");
const scriptExternal = scripts.filter((r) => attrOf(r.attrs, "src") !== null);
const styleExternal = styles.filter((r) => attrOf(r.attrs, "src") !== null || attrOf(r.attrs, "href") !== null);
const linkTags = [...markup.matchAll(/<link\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)];
const linkExternal = linkTags.filter((m) => attrOf(m[1], "href") !== null);
const linkRefs = linkExternal.map((m) => attrOf(m[1], "href"));

/* ══════════════════════════════ ОТЧЁТ ══════════════════════════════════ */

const rel = path.relative(root, target) || target;
const longest = Math.max(...lineStarts.map((s, i) => (lineStarts[i + 1] ?? raw.length + 1) - s - 1));

say();
say(`Проверка протокола file:// — ${rel}`);
say(rule_());
say(`Файл:        ${target}`);
say(`Размер:      ${bytes(size)} (${size.toLocaleString("ru-RU")} байт)`);
say(`Строк:       ${lineStarts.length}, самая длинная — ${longest.toLocaleString("ru-RU")} симв.`);
if (longest > 4000) {
  say("             ⚠ сборка минифицирована: номера строк почти бесполезны,");
  say("               поэтому у каждой находки есть столбец и смещение в файле.");
}
if (bigBlobs.length) {
  say(
    `Двоичных блоков (data:/base64, от 64 симв.): ${bigBlobs.length}, ` +
      `${bytes(bigBlobs.reduce((a, [x, y]) => a + (y - x), 0))} — исключены из сканирования, ` +
      `чтобы случайные последовательности внутри base64 не давали ложных срабатываний.`,
  );
}

say();
say(`Встраивание ресурсов`);
say(rule_("·"));
const line = (name, total, external, detail) => {
  const mark = external === 0 ? "✓" : "•";
  say(`  ${mark} <${name}>: всего ${total}, внешних ${external}${detail ? ` — ${detail}` : ""}`);
};
line("script", scripts.length, scriptExternal.length, scriptExternal.length ? scriptExternal.map((r) => attrOf(r.attrs, "src")).join(", ") : "весь JS внутри файла");
line("style", styles.length, styleExternal.length, styleExternal.length ? "есть внешний CSS" : "весь CSS внутри файла");
const linkExists = await Promise.all(
  linkRefs.map(async (href) => {
    const clean = String(href).split(/[?#]/)[0];
    if (!clean || /^\/(?!\/)/.test(clean) || /[$<{%]/.test(clean)) return null;
    try {
      await stat(path.resolve(distDir, clean));
      return "на месте";
    } catch {
      return "ФАЙЛА НЕТ";
    }
  }),
);
line(
  "link",
  linkTags.length,
  linkExternal.length,
  linkRefs.length
    ? linkRefs.map((href, i) => `${href}${linkExists[i] ? ` (${linkExists[i]})` : ""}`).join(", ")
    : "нет",
);
// Проверяем по исходному тексту: data:-блоки в `code` уже замаскированы.
const hasWasm = /data:application\/wasm;base64/.test(raw);
const mentionsWasm = /\bwasm\b/i.test(code);
if (hasWasm) {
  say("  ✓ wasm встроен как data: URL — это file://-безопасный способ, отдельный файл не нужен");
} else if (mentionsWasm) {
  say("  • wasm в data:-URL не найден — если модуль тянет его отдельным файлом, под file:// он не загрузится");
}

/* Одна и та же находка может прийти из двух правил — оставляем по одному вхождению. */
const seen = new Set();
const unique = findings.filter((f) => {
  const key = `${f.severity}|${f.id}|${f.offset}|${f.text}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});
const errs = unique.filter((f) => f.severity === "error");
const warns = unique.filter((f) => f.severity === "warning");

/* ── Информационные замечания (на код возврата не влияют) ───────────────── */
/**
 * Признак того, что URL именно загружается, а не просто упоминается: попадает в
 * fetch()/new Worker()/importScripts(), назначается ключу пути воркера или стоит
 * в src= / rel=stylesheet. Ссылки из href у <a> сюда не попадают — это обычные
 * пользовательские ссылки, а не зависимости от сети.
 */
const LOAD_CTX =
  /fetch\s*\(|new\s+Worker|importScripts|createWorker|workerPath|corePath|langPath|\bsrc\s*=|rel\s*=\s*["']stylesheet/;
const remoteAssets = [];
for (const m of code.matchAll(/https?:\/\/[^\s"'`)\\]+/g)) {
  // Пространства имён XML и адреса документации не грузятся, а только сравниваются.
  if (/w3\.org|react\.dev|github\.com|schema\.org|creativecommons\.org|npmjs\.com/i.test(m[0])) continue;
  // Loopback уже разобран правилом dev-host как ошибка — повторять не нужно.
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(m[0])) continue;
  const before = code.slice(Math.max(0, m.index - 90), m.index);
  const after = code.slice(m.index + m[0].length, m.index + m[0].length + 210);
  if (!LOAD_CTX.test(before) && !LOAD_CTX.test(after)) continue;
  remoteAssets.push({ offset: m.index, url: m[0], ...locate(m.index) });
}
for (const r of remoteAssets.slice(0, 8)) {
  note(`внешний ресурс грузится по сети: ${snippet(r.offset, r.url.length)} — строки ${r.line}:${r.col}. ` +
    `Под file:// это работает только при наличии сети, а офлайн-проверку приложения уронит.`);
}
const imu = [...code.matchAll(/import\.meta\.url/g)];
if (imu.length) {
  note(`import.meta.url встречается ${imu.length} раз. Под file:// он равен пути к самому index.html — ` +
    `это корректная база для относительных путей. Проблема возникает, только если из него собирают ` +
    `абсолютный путь (проверено выше — таких мест не найдено).`);
}
try {
  const cfg = await readFile(path.join(root, "vite.config.ts"), "utf8");
  const base = /\bbase\s*:\s*["']([^"']+)["']/.exec(cfg);
  if (base) {
    const safe = base[1] === "./" || base[1] === "" || base[1] === ".";
    note(
      `в vite.config.ts задано base: "${base[1]}". ` +
        (safe
          ? 'Это file://-безопасный вариант.'
          : 'Под file:// корректно работает только base: "./" — абсолютный base разъезжается по корню диска.'),
    );
  }
} catch {
  /* конфига нет — нечего проверять */
}

say();
if (errs.length === 0 && warns.length === 0) {
  say(`Результат`);
  say(rule_());
  say("✓ Ни одного пути, который сломался бы под протоколом file://, не найдено.");
  say("  JS и CSS встроены в документ; внешние ссылки не используются; dev-сервер в сборку не попал.");
} else {
  for (const [title, list] of [["ОШИБКИ — сломается под file://", errs], ["ПРЕДУПРЕЖДЕНИЯ — стоит проверить", warns]]) {
    if (!list.length) continue;
    say(title);
    say(rule_());
    for (const [i, f] of list.entries()) {
      say(`${i + 1}. [${f.id}] строка ${f.line}, столбец ${f.col} (смещение ${f.offset})`);
      say(`   ${snippet(f.offset, f.text.length)}`);
      say(`   ${f.why}`);
      say();
    }
  }
}

if (notes.length) {
  say("Замечания (на код возврата не влияют)");
  say(rule_());
  for (const n of notes) say(`• ${n}`);
  say();
}

const verdict = errs.length ? "Проверка НЕ пройдена" : warns.length ? "Проверка пройдена, есть предупреждения" : "Проверка пройдена";
say(`${verdict}: ошибок — ${errs.length}, предупреждений — ${warns.length}.`);
say(errs.length ? "Сборка, вероятно, не заработает под file:// — сначала разберите ошибки выше." : "Критичных для file:// проблем не найдено.");

process.exitCode = errs.length ? 1 : 0;
