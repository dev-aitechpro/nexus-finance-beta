#!/usr/bin/env node
// scripts/check-desktop-db.mjs
// Проверка рабочей базы данных настольного приложения (Electron).
//
// Что проверяем и почему. В приложении SQLite живёт в памяти рендерера
// (sql.js, WASM): src/storage/sqlite.ts после каждой транзакции делает
// db.export() и отдаёт байты снапшот-хранилищу. В Electron это
// ElectronSnapshotStore (src/storage/snapshots.ts), который через IPC
// просит главный процесс записать файл в профиль пользователя
// (electron-main.cjs: getDbPath() → <userData>/nexus-data.sqlite).
// То есть единственный признак того, что приложение реально сохранило
// данные, — сам файл снапшота на диске. Этот скрипт его и проверяет.
//
// Проверки (в порядке «дешёвое → дорогое»):
//   1. файл существует (ищем по тем же правилам, что и Electron);
//   2. размер больше нуля;
//   3. первые 16 байт — сигнатура SQLite `SQLite format 3\0`;
//   4. файл открывается sql.js (WASM читается с диска, как в
//      tests/helpers/sqljs.ts и scripts/bench-storage.mjs);
//   5. quick_check целостности;
//   6. есть все таблицы из src/storage/schema.ts и в них есть колонки;
//   7. число строк в каждой таблице, версия схемы (meta.schema_version).
//
// Скрипт строго читающий: он не пишет, не переименовывает и не создаёт
// файл БД. Главный процесс пишет атомарно (временный файл + rename),
// поэтому параллельный запуск приложения не мешает чтению.
//
// Запуск: node scripts/check-desktop-db.mjs
// Диагностический путь (для тестов на битом файле):
//   node scripts/check-desktop-db.mjs <путь-к-файлу>
//   NEXUS_DESKTOP_DB=<путь-к-файлу> node scripts/check-desktop-db.mjs
//
// Код возврата: 0 — база читается и все ожидаемые таблицы на месте,
//              1 — любой провал. Отчёт печатается в stdout, объяснение
//              провала — в stderr (с префиксом «✗»).
import { readFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SELF_DIR, "..");

/** Имя файла БД — ровно как в electron-main.cjs (getDbPath). */
const DB_FILE = "nexus-data.sqlite";
/** Колонки служебной таблицы meta: metaSchemaOps() в src/storage/schema.ts. */
const META_COLUMNS = ["key", "value"];

/** Первые 16 байт любой базы SQLite: `SQLite format 3\0`. */
const SQLITE_MAGIC = Buffer.from([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
]);
/** `SQLite format 3\0` в виде читаемой строки — так его показывает sqlite3. */
const SQLITE_MAGIC_TEXT = "SQLite format 3\\u0000";

/** Падаем с кодом 1 после уже напечатанного объяснения. */
const bail = (message) => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

/* ───────────────────── ожидаемая схема (из исходников) ───────────────────── */

/**
 * Ожидания берём из src/storage/schema.ts, а не из копии в этом файле:
 * имена таблиц и колонок тогда не могут разойтись с приложением.
 * Модуль — обычный TypeScript без transform-конструкций, Node 22.18+/24
 * читает его сам. Если импорт не удался (старый Node, нет исходников в
 * собранной копии) — откатываемся на зашитые имена и честно пишем об этом.
 */
const FALLBACK_SCHEMA = {
  source: "зашитая копия имён (src/storage/schema.ts не прочитался)",
  version: 1,
  metaTable: "meta",
  metaVersionKey: "schema_version",
  collections: [
    { collection: "transactions", table: "transactions", columns: ["id", "type", "category", "amount", "description", "date", "source", "status", "sourceId", "createdAt", "doc"] },
    { collection: "subscriptions", table: "subscriptions", columns: ["id", "name", "amount", "period", "billingDay", "reminderDays", "lastConfirmed", "createdAt", "doc"] },
    { collection: "fixedPayments", table: "fixed_payments", columns: ["id", "name", "amount", "category", "payDay", "autoPay", "lastConfirmed", "createdAt", "doc"] },
    { collection: "budgets", table: "budgets", columns: ["id", "category", "limit", "createdAt", "doc"] },
    { collection: "goals", table: "goals", columns: ["id", "name", "targetAmount", "savedAmount", "deadline", "createdAt", "doc"] },
    { collection: "investments", table: "investments", columns: ["id", "ticker", "quantity", "buyPrice", "currentPrice", "createdAt", "doc"] },
    { collection: "pendingPayments", table: "pending_payments", columns: ["id", "sourceType", "sourceId", "name", "amount", "category", "dueDate", "createdAt", "status", "skippedCount", "lastSkippedDate", "carryOverAmount", "doc"] },
    { collection: "skippedPayments", table: "skipped_payments", columns: ["id", "sourceId", "sourceType", "originalAmount", "skippedDate", "dueDate", "carryOver", "carriedAmount", "doc"] },
  ],
};

const loadExpectedSchema = async () => {
  try {
    const m = await import(pathToFileURL(path.join(ROOT, "src", "storage", "schema.ts")).href);
    if (!Array.isArray(m.COLLECTION_SPECS) || m.COLLECTION_SPECS.length === 0) throw new Error("пустой COLLECTION_SPECS");
    return {
      source: "src/storage/schema.ts",
      version: m.SCHEMA_VERSION,
      metaTable: m.META_TABLE,
      metaVersionKey: m.META_VERSION_KEY,
      collections: m.COLLECTION_SPECS.map((s) => ({
        collection: s.collection,
        table: s.table,
        // Колонка `doc` добавляется createTableOps() к колонкам коллекции.
        columns: [...s.columns.map((c) => c.name), "doc"],
      })),
    };
  } catch (err) {
    console.error(`[warn] не удалось импортировать src/storage/schema.ts: ${err.message}`);
    return FALLBACK_SCHEMA;
  }
};

/* ───────────────────────── где искать файл БД ───────────────────────── */

/** Базовый каталог userData — те же правила, что у Electron (app.getPath). */
const userDataBase = () => {
  if (process.platform === "win32") {
    return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
};

/**
 * Имена каталогов профиля: productName из package.json (в сборке electron-builder
 * именно он становится именем приложения, а значит и папкой userData), затем
 * name из package.json (запуск `electron .` из исходников без сборки) и
 * дефолт Electron. Ничего не выдумываем — всё читается из проекта.
 */
const profileDirNames = async () => {
  const names = [];
  try {
    const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
    for (const name of [pkg?.build?.productName, pkg?.name]) {
      if (typeof name === "string" && name.length > 0) names.push(name);
    }
  } catch {
    /* package.json недоступен — останутся только дефолты ниже */
  }
  names.push("Electron");
  return [...new Set(names)];
};

const exists = async (target) => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * Кандидаты в порядке приоритета. Возвращает и найденные, и проверенные
 * (вторые нужны для диагностики, когда файла нет).
 */
const locateDb = async () => {
  const base = userDataBase();
  const names = await profileDirNames();
  const candidates = names.map((name) => path.join(base, name, DB_FILE));

  // Явный путь важнее всего: им пользуются при проверке битого файла.
  const override = process.argv[2] || process.env.NEXUS_DESKTOP_DB;
  if (override) {
    const explicit = path.resolve(override);
    return {
      base,
      found: (await exists(explicit)) ? explicit : null,
      checked: [explicit],
      explicit: true,
    };
  }

  for (const candidate of candidates) {
    if (await exists(candidate)) return { base, found: candidate, checked: candidates, explicit: false };
  }

  // Имя каталога профиля может отличаться (другая сборка, другой productName).
  // Тогда ищем файл в каталогах верхнего уровня userData — это всё ещё чтение.
  try {
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(base, entry.name, DB_FILE);
      if (await exists(candidate)) {
        return { base, found: candidate, checked: [...candidates, `${base}\\*\\${DB_FILE}`], explicit: false };
      }
    }
  } catch {
    /* userData недоступен — сообщим списком проверенных путей */
  }

  return { base, found: null, checked: [...candidates, `${base}\\*\\${DB_FILE}`], explicit: false };
};

/* ────────────────────────────── работа с БД ────────────────────────────── */

/** sql.js грузим так же, как scripts/bench-storage.mjs: WASM с диска, без HTTP. */
const loadSqlJs = async () => {
  const require = createRequire(import.meta.url);
  const distDir = path.dirname(require.resolve("sql.js/dist/sql-wasm.js"));
  const wasmBinary = readFileSync(path.join(distDir, "sql-wasm.wasm"));
  const initSqlJs = (await import("sql.js/dist/sql-wasm.js")).default;
  const SQL = await initSqlJs({ wasmBinary });
  return { SQL, version: require("sql.js/package.json").version };
};

/**
 * Все строки запроса в виде объектов (как SqlDriver.query в src/storage/sqlite.ts).
 * Ошибку перебрасываем с текстом самого запроса: у обрезанного образа базы
 * `new SQL.Database()` проходит молча, и «file is not a database» всплывает
 * только на первом же prepare — без контекста это нечитаемый traceback.
 */
const queryAll = (db, sql, params = []) => {
  const flat = sql.replace(/\s+/g, " ").trim();
  try {
    const stmt = db.prepare(sql);
    try {
      if (params.length) stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  } catch (err) {
    throw new Error(`запрос «${flat}» не выполнен: ${err.message}`);
  }
};

const scalar = (db, sql, params = []) => {
  const rows = queryAll(db, sql, params);
  return rows.length ? Object.values(rows[0])[0] : undefined;
};

/* ────────────────────────────── вывод ────────────────────────────── */

/** Ширина строки по кодовым точкам (кириллица — один символ). */
const width = (text) => [...String(text)].length;

const pad = (text, size) => {
  const str = String(text);
  const gap = size - width(str);
  return gap > 0 ? str + " ".repeat(gap) : str;
};

const printTable = (headers, rows) => {
  const sizes = headers.map((cell, i) => Math.max(width(cell), ...rows.map((r) => width(r[i]))));
  const line = (cells) => "  " + cells.map((cell, i) => pad(cell, sizes[i])).join("  ");
  console.log(line(headers).trimEnd());
  console.log("  " + sizes.map((s) => "-".repeat(s)).join("  "));
  for (const row of rows) console.log(line(row).trimEnd());
};

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${bytes} Б (${(bytes / 1024).toFixed(1)} КБ)`;
  return `${bytes} Б (${(bytes / 1024 / 1024).toFixed(2)} МБ)`;
};

const formatTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "неизвестно";
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

/* ────────────────────────────── основной сценарий ────────────────────────────── */

const expected = await loadExpectedSchema();
const { base, found, checked, explicit: explicitPath } = await locateDb();

console.log("=".repeat(96));
console.log(" Проверка настольной базы NEXUS Finance (Electron, sql.js + файл-снапшот в профиле)");
console.log("=".repeat(96));
console.log(` Платформа   : ${process.platform} ${process.arch}, Node ${process.version}`);
console.log(` userData    : ${base}`);
console.log(` Ожидания    : ${expected.source}, схема v${expected.version}`);
console.log(` Имя файла БД: ${DB_FILE} (electron-main.cjs → app.getPath("userData"))`);

// 1. Файла нет — это не ошибка проверки, а отсутствие базы. Объясняем, что делать.
if (!found) {
  console.log("");
  console.log(" Проверенные пути:");
  for (const item of checked) console.log(`   • ${item}`);
  console.log("");
  bail(
    explicitPath
      ? `файл БД не найден по указанному пути: ${checked[0]}\n  Проверьте путь — скрипт ничего не создаёт и не изменяет.`
      : "база не создана: файл БД в профиле пользователя не найден.\n" +
          "  Запустите настольное приложение (npm run electron:debug или собранный NEXUS Finance),\n" +
          "  дождитесь автосохранения (оно выполняется после каждой транзакции) и запустите\n" +
          "  эту проверку снова. Пустой файл означает, что приложение ещё ни разу не сохранило данные.",
  );
}

console.log(` Файл БД     : ${found}`);

// 2. Размер и сигнатура — до sql.js, чтобы битый файл не ронял WASM.
// stat делаем до и после чтения: главный процесс пишет файл атомарно, но если
// база всё же меняется на лету, лучше сказать об этом, чем считать мусор.
let bytes;
let info;
try {
  info = await stat(found);
  bytes = await readFile(found);
} catch (err) {
  bail(`не удалось прочитать файл БД: ${err.message}`);
}
try {
  const after = await stat(found);
  if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
    bail(
      "файл БД изменился во время чтения (приложение сохраняет базу прямо сейчас) —\n" +
        "  запустите проверку ещё раз, когда автосохранение закончится.",
    );
  }
} catch (err) {
  bail(`не удалось повторно прочитать сведения о файле БД: ${err.message}`);
}

console.log(` Размер      : ${formatBytes(bytes.byteLength)}`);
console.log(` Изменён     : ${formatTime(info.mtime.toISOString())}`);

if (bytes.byteLength === 0) {
  bail(
    "файл БД пустой (0 байт): база не инициализирована. Запустите приложение и дождитесь\n" +
      "  автосохранения — снапшот появляется только после первой успешной записи.",
  );
}

const head = bytes.subarray(0, SQLITE_MAGIC.length);
const magicOk = head.equals(SQLITE_MAGIC);
console.log(
  ` Сигнатура   : ${magicOk ? `✓ SQLite format 3\\0` : `✗ ожидалась «${SQLITE_MAGIC_TEXT}»`}`,
);
if (!magicOk) {
  console.log(` Первые байты: ${[...head].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
  bail(
    `файл не является базой SQLite: в начале нет сигнатуры «${SQLITE_MAGIC_TEXT}»\n` +
      `  (${[...SQLITE_MAGIC].map((b) => b.toString(16).padStart(2, "0")).join(" ")}).\n` +
      "  Похоже, файл повреждён или это не файл базы. Приложение при старте такой файл\n" +
      "  проигнорирует и начнёт с чистой базы — данные из него восстановить нельзя.",
  );
}

// 3. Открытие в sql.js. Всё, что ниже, работает с копией образа в памяти.
let SQL;
let sqlJsVersion;
try {
  ({ SQL, version: sqlJsVersion } = await loadSqlJs());
} catch (err) {
  bail(`не удалось загрузить sql.js из node_modules: ${err.message}. Выполните npm install.`);
}
console.log(` sql.js      : ${sqlJsVersion}`);

let db;
try {
  db = new SQL.Database(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
} catch (err) {
  bail(
    `база не открывается: ${err.message}\n` +
      "  Файл начинается как SQLite, но образ повреждён или обрезан (например, оборвалась\n" +
      "  запись при выключении). Приложение в такой ситуации начнёт с чистой базы.",
  );
}

try {
  const check = String(scalar(db, "PRAGMA quick_check") ?? "").toLowerCase();
  console.log(` Целостность : ${check === "ok" ? "✓ ok" : `✗ ${check}`}`);
  if (check !== "ok") {
    bail(`PRAGMA quick_check не пройден (${check}) — образ базы повреждён.`);
  }

  // 4. Таблицы приложения.
  const present = new Map(
    queryAll(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => [String(r.name), true]),
  );
  const rows = [];
  const problems = [];

  for (const spec of expected.collections) {
    if (!present.has(spec.table)) {
      problems.push(`нет таблицы «${spec.table}» (коллекция ${spec.collection})`);
      rows.push([spec.table, "—", "нет таблицы"]);
      continue;
    }
    const columns = queryAll(db, `PRAGMA table_info("${spec.table}")`).map((r) => String(r.name));
    const missing = spec.columns.filter((c) => !columns.includes(c));
    if (missing.length > 0) {
      problems.push(`в таблице «${spec.table}» нет колонок: ${missing.join(", ")}`);
    }
    rows.push([
      spec.table,
      `${columns.length}${missing.length ? ` (−${missing.length})` : ""}`,
      String(scalar(db, `SELECT COUNT(*) FROM "${spec.table}"`) ?? 0),
    ]);
  }

  // Служебная meta: без неё приложение не знает версию схемы и настройки.
  if (!present.has(expected.metaTable)) {
    problems.push(`нет служебной таблицы «${expected.metaTable}»`);
    rows.push([expected.metaTable, "—", "нет таблицы"]);
  } else {
    const columns = queryAll(db, `PRAGMA table_info("${expected.metaTable}")`).map((r) => String(r.name));
    const missing = META_COLUMNS.filter((c) => !columns.includes(c));
    if (missing.length > 0) problems.push(`в таблице «${expected.metaTable}» нет колонок: ${missing.join(", ")}`);
    rows.push([`${expected.metaTable} (служебная)`, `${columns.length}${missing.length ? ` (−${missing.length})` : ""}`, String(scalar(db, `SELECT COUNT(*) FROM "${expected.metaTable}"`) ?? 0)]);
  }

  console.log("");
  printTable(["Таблица", "Колонок", "Строк"], rows);

  // 5. Версия схемы.
  let version = null;
  if (present.has(expected.metaTable)) {
    const raw = scalar(db, `SELECT "value" FROM "${expected.metaTable}" WHERE "key" = ?`, [
      expected.metaVersionKey,
    ]);
    const parsed = Number.parseInt(String(raw ?? ""), 10);
    if (raw !== undefined && raw !== null) version = Number.isFinite(parsed) ? parsed : String(raw);
  }
  console.log("");
  console.log(` Версия схемы: ${version === null ? `не записана (ожидается ${expected.version})` : `${version} (ожидается ${expected.version})`}`);
  if (version === null) {
    problems.push(`в ${expected.metaTable} нет ключа «${expected.metaVersionKey}» — версия схемы неизвестна`);
  } else if (Number.isFinite(version) && version < expected.version) {
    problems.push(`база на схеме v${version}, приложение ждёт v${expected.version} — нужна миграция (запустите приложение)`);
  } else if (Number.isFinite(version) && version > expected.version) {
    problems.push(`база на схеме v${version} новее приложения (v${expected.version}) — запись в неё отключена`);
  }

  // Прочие таблицы (миграции, расширения) — просто показываем.
  const known = new Set([...expected.collections.map((c) => c.table), expected.metaTable]);
  const extra = [...present.keys()].filter((t) => !known.has(t) && !t.startsWith("sqlite_"));
  if (extra.length > 0) {
    console.log(` Прочие      : ${extra.join(", ")}`);
  }

  if (problems.length > 0) {
    console.log("");
    bail(`база читается, но структура неполна:\n  - ${problems.join("\n  - ")}`);
  }

  const total = rows.reduce((n, r) => n + (Number(r[2]) || 0), 0);
  console.log("");
  console.log(
    ` Итог: ✓ база читается, схема v${version}, все ${expected.collections.length} таблиц данных и «${expected.metaTable}» на месте (строк всего: ${total})`,
  );
} catch (err) {
  // Сюда попадает обрезанный образ: заголовок верный, тела нет, и первая же
  // выборка падает с «file is not a database». Без этого catch был бы traceback.
  bail(
    `содержимое базы прочитать не удалось: ${err.message}\n` +
      "  Файл начинается как SQLite, но образ неполный или повреждён (например, запись\n" +
      "  оборвалась). Приложение в такой ситуации начнёт с чистой базы, а не восстановит данные.",
  );
} finally {
  try {
    db?.close();
  } catch {
    /* уже закрыта */
  }
}

process.exit(0);
