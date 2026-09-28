#!/usr/bin/env node
// scripts/bench-storage.mjs
// Бенчмарк слоя хранения по ТЗ («Техническое задание1.md», Группа 5:
// «Бенчмарки: время старта, задержка SQLite-запросов»).
//
// ВАЖНО: абсолютные цифры зависят от машины (CPU, ОС, версия Node и sql.js),
// от нагрузки в фоне и от того, прогревался ли JIT. Сравнивать нужно только
// прогоны на одном и том же железе. Ниже печатаются медиана/минимум/максимум
// и полный набор замеров, чтобы шум был виден.
//
// Что измеряется (все числа — миллисекунды, если не указано иное):
//   * cold-start — создание SqliteStorage + init() + read() пустой базы + version();
//   * restore     — восстановление из снапшота: новый адаптер, init() + read();
//   * write       — последовательные write() при 10/100/500/1000 записях;
//   * read        — read() при 1000 записях;
//   * query       — точечный SELECT по индексу даты (таблица transactions);
//   * size        — размер базы в КБ при максимальном числе записей.
//
// Запуск: node scripts/bench-storage.mjs   (или npm run bench)
//
// Как это работает: исходники хранилища написаны на TypeScript, а Node
// исполняет ESM. Поэтому скрипт (1) регистрирует резолвер, дописывающий
// расширение `.ts` к относительным импортам без суффикса (проект собирается
// с moduleResolution: "bundler"), и (2) при необходимости перезапускает себя
// с флагом --experimental-transform-types: в sqlite.ts есть TS-конструкция
// (parameter property в конструкторе драйвера), которую "strip-only" режим Node
// снимать не умеет. Никаких новых зависимостей не требуется.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), "..");
const OUT_DIR = path.join(ROOT, "benchmarks");
const OUT_FILE = path.join(OUT_DIR, "storage.json");

/* ───────────────────────── разрешение TS-импортов ───────────────────────── */

/** Суффиксы, которые пробуем подставить к относительному импорту без суффикса. */
const RESOLVE_SUFFIXES = [".ts", ".tsx", "/index.ts", ".js", "/index.js"];

const HAS_SUFFIX = /\.(m?[jt]sx?|c?js|json|node|wasm)$/i;

const isRelative = (specifier) => specifier.startsWith("./") || specifier.startsWith("../");

/** Синхронный хук (module.registerHooks, Node >= 22.15) — работает в том же потоке. */
const syncResolveHooks = {
  resolve(specifier, context, nextResolve) {
    if (isRelative(specifier) && !HAS_SUFFIX.test(specifier)) {
      for (const suffix of RESOLVE_SUFFIXES) {
        try {
          return nextResolve(specifier + suffix, context);
        } catch {
          /* такого файла нет — пробуем следующий кандидат */
        }
      }
    }
    return nextResolve(specifier, context);
  },
};

/** Асинхронный хук (module.register) — запасной путь для Node без registerHooks. */
const asyncResolveHooksSource = `
const SUFFIXES = ${JSON.stringify(RESOLVE_SUFFIXES)};
const HAS_SUFFIX = ${HAS_SUFFIX.toString()};
export async function resolve(specifier, context, nextResolve) {
  const relative = specifier.startsWith("./") || specifier.startsWith("../");
  if (relative && !HAS_SUFFIX.test(specifier)) {
    for (const suffix of SUFFIXES) {
      try {
        return await nextResolve(specifier + suffix, context);
      } catch {
        /* такого файла нет — пробуем следующий кандидат */
      }
    }
  }
  return nextResolve(specifier, context);
}
`;

/**
 * @returns {Promise<string>} как именно зарегистрирован резолвер
 */
const registerTsResolver = async () => {
  const mod = await import("node:module");
  const forceAsync = process.env.NEXUS_BENCH_ASYNC_HOOKS === "1";
  if (!forceAsync && typeof mod.registerHooks === "function") {
    mod.registerHooks(syncResolveHooks);
    return "module.registerHooks";
  }
  if (typeof mod.register === "function") {
    mod.register(`data:text/javascript,${encodeURIComponent(asyncResolveHooksSource)}`, import.meta.url);
    return "module.register (data: URL)";
  }
  throw new Error("Текущий Node не умеет регистрировать ESM-резолвер (нужен Node >= 22.15)");
};

/* ───────────────────────── запуск: подъём Node при необходимости ───────────────────────── */

const TRANSFORM_FLAG = "--experimental-transform-types";
const CHILD_MARK = "NEXUS_BENCH_TS_CHILD";

const hasTransformFlag = () =>
  [...process.execArgv, process.env.NODE_OPTIONS ?? ""].some((a) => a.includes("transform-types"));

/** Перезапуск себя с флагом трансформации типов. Дальше процесс не продолжает. */
const reexecWithTransform = () => {
  const result = spawnSync(
    process.execPath,
    [
      TRANSFORM_FLAG,
      "--disable-warning=ExperimentalWarning",
      SELF,
      ...process.argv.slice(2),
    ],
    { stdio: "inherit", env: { ...process.env, [CHILD_MARK]: "1" } },
  );
  if (result.error) {
    console.error(`Не удалось перезапустить Node с ${TRANSFORM_FLAG}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
};

const tsUrl = (...parts) => pathToFileURL(path.join(ROOT, ...parts)).href;

const resolverKind = await registerTsResolver();

/** Модуль src/storage/sqlite.ts. Импорт динамический: ради него поднимается резолвер выше. */
let sqlite;
try {
  sqlite = await import(tsUrl("src", "storage", "sqlite.ts"));
} catch (err) {
  if (hasTransformFlag() || process.env[CHILD_MARK]) {
    console.error("Не удалось импортировать src/storage/sqlite.ts из Node:", err);
    process.exit(1);
  }
  reexecWithTransform();
}

/* ───────────────────────── зависимости приложения ───────────────────────── */

const { SqliteStorage } = sqlite;
const { MemorySnapshotStore } = await import(tsUrl("src", "storage", "snapshots.ts"));
const { SCHEMA_VERSION, COLLECTION_SPECS } = await import(tsUrl("src", "storage", "schema.ts"));
const { sampleData, tx } = await import(tsUrl("tests", "helpers", "fixtures.ts"));

// Тот же приём, что в tests/helpers/sqljs.ts: WASM читается с диска, без HTTP
// и без file:// — иначе sql.js не найдёт бинарник.
const require = createRequire(import.meta.url);
const sqlJsDist = path.dirname(require.resolve("sql.js/dist/sql-wasm.js"));
const sqlJsPkg = require("sql.js/package.json");
const wasmBinary = readFileSync(path.join(sqlJsDist, "sql-wasm.wasm"));

/** @type {import("src/storage/sqlite").SqlJsLoader} */
const nodeSqlJsLoader = async (config) => {
  const initSqlJs = (await import("sql.js/dist/sql-wasm.js")).default;
  return initSqlJs({ ...config, wasmBinary });
};

/* ───────────────────────── утилиты измерения ───────────────────────── */

/** Медиана: для чётного n — среднее двух центральных значений. */
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const round = (value, digits = 3) => {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};

/**
 * Замер одной операции. Возвращает миллисекунды, прошедшие внутри `run`.
 * @template T
 * @param {() => T | Promise<T>} run
 * @returns {Promise<{ ms: number, value: T }>}
 */
const timed = async (run) => {
  const t0 = performance.now();
  const value = await run();
  return { ms: performance.now() - t0, value };
};

/** Открыть адаптер и сразу закрыть его — освободить WASM-память. */
const dispose = async (storage) => {
  try {
    await storage.sql.close();
  } catch {
    /* уже закрыт */
  }
};

/** Новый адаптер с собственным пустым хранилищем снапшотов. */
const newStorage = (store = new MemorySnapshotStore()) =>
  new SqliteStorage({ snapshots: store, load: nodeSqlJsLoader });

/* ───────────────────────── тестовые данные ───────────────────────── */

const CATEGORIES = ["groceries", "cafe", "transport", "housing", "fun", "health", "shopping", "salary"];
const DAY_MS = 86400000;
const BASE_DAY = Date.UTC(2024, 0, 1);

/** Дата записи i: 365-дневный цикл, чтобы на одну дату приходилось несколько строк. */
const isoDay = (i) => new Date(BASE_DAY + (i % 365) * DAY_MS).toISOString().slice(0, 10);

/**
 * AppData на `count` транзакций. Основа — sampleData() из tests/helpers/fixtures.ts,
 * так что в базе всегда есть ещё подписка и цель (две непустые коллекции).
 */
const buildData = (count) => {
  const base = {
    ...sampleData(),
    transactions: Array.from({ length: count }, (_, i) =>
      tx({
        id: `t${i}`,
        type: i % 10 === 0 ? "income" : "expense",
        category: CATEGORIES[i % CATEGORIES.length],
        amount: round(10 + (i % 997) * 1.37, 2),
        description: `Запись №${i}`,
        date: isoDay(i),
        source: i % 7 === 0 ? "payment" : "manual",
        createdAt: `${isoDay(i)}T10:00:00.000Z`,
      }),
    ),
  };
  return base;
};

/* ───────────────────────── сбор результатов ───────────────────────── */

/** @type {Array<{name: string, unit: string, median: number, min: number, max: number, samples: number[], details?: Record<string, unknown>}>} */
const cases = [];

/**
 * Добавить замер в отчёт.
 * @param {string} name
 * @param {string} unit
 * @param {number[]} samples
 * @param {Record<string, unknown>} [details]
 */
const addCase = (name, unit, samples, details) => {
  cases.push({
    name,
    unit,
    median: round(median(samples)),
    min: round(Math.min(...samples)),
    max: round(Math.max(...samples)),
    samples: samples.map((s) => round(s)),
    ...(details ? { details } : {}),
  });
};

const REPEATS = {
  coldStart: 7,
  restore: 5,
  write: 5,
  read: 10,
  query: 200,
};
const WRITE_SIZES = [10, 100, 500, 1000];
const MAX_RECORDS = Math.max(...WRITE_SIZES);

/* ── 1. Холодный старт: первый адаптер в этом процессе ───────────────────────── */
const data = buildData(MAX_RECORDS);
const dataBySize = new Map(WRITE_SIZES.map((n) => [n, buildData(n)]));

// Первый запуск в процессе тянет за собой инициализацию sql.js и компиляцию
// WASM — это и есть «холодный старт приложения» целиком. Один замер, без медианы.
{
  const storage = newStorage();
  const { ms, value } = await timed(async () => {
    await storage.init();
    const empty = await storage.read();
    const version = await storage.version();
    return { empty, version };
  });
  if (value.version !== SCHEMA_VERSION) {
    throw new Error(`Ожидалась схема v${SCHEMA_VERSION}, получена v${value.version}`);
  }
  addCase("cold-start/first-in-process (включая компиляцию WASM)", "ms", [ms], {
    note: "единичный замер: загрузка sql.js + компиляция WASM + схема + read()",
  });
  await dispose(storage);
}

/* ── 2. Холодный старт адаптера (WASM уже прогрет) ───────────────────────── */
{
  const samples = [];
  for (let i = 0; i < REPEATS.coldStart; i++) {
    // Свежий адаптер каждый раз: повторно прогретый адаптер — это не холодный старт.
    const storage = newStorage();
    const { ms } = await timed(async () => {
      await storage.init();
      await storage.read();
      await storage.version();
    });
    samples.push(ms);
    await dispose(storage);
  }
  addCase("cold-start/empty-db (адаптер + init + read + version)", "ms", samples, {
    repeats: REPEATS.coldStart,
    note: "каждый повтор — новый SqliteStorage и новая in-memory БД",
  });
}

/* ── 3. Восстановление из снапшота ───────────────────────── */
{
  // Готовим снапшот один раз: его байты — вход восстановления.
  const store = new MemorySnapshotStore();
  const seed = newStorage(store);
  await seed.init();
  await seed.write(data);
  const bytes = await store.load();
  if (!bytes) throw new Error("Снапшот не записался в MemorySnapshotStore");
  await dispose(seed);

  const samples = [];
  for (let i = 0; i < REPEATS.restore; i++) {
    const target = new MemorySnapshotStore();
    await target.save(bytes); // «файл базы» уже лежит на диске
    const storage = newStorage(target);
    const { ms, value } = await timed(async () => {
      await storage.init();
      return await storage.read();
    });
    if (!value || value.transactions.length !== MAX_RECORDS) {
      throw new Error(`Восстановлено ${value?.transactions.length ?? 0} записей вместо ${MAX_RECORDS}`);
    }
    samples.push(ms);
    await dispose(storage);
  }
  addCase(`restore-from-snapshot/${MAX_RECORDS} (снапшот → init + read)`, "ms", samples, {
    records: MAX_RECORDS,
    snapshotKb: round(bytes.byteLength / 1024, 1),
    repeats: REPEATS.restore,
  });
}

/* ── 4. Запись при нарастающем числе записей ───────────────────────── */
const sizeByRecords = new Map();
for (const count of WRITE_SIZES) {
  const storage = newStorage();
  await storage.init();
  const payload = dataBySize.get(count);
  const samples = [];
  for (let i = 0; i < REPEATS.write; i++) {
    const { ms, value } = await timed(() => storage.write(payload));
    if (value !== true) throw new Error("write() вернул не true");
    samples.push(ms);
  }
  const bytes = await storage.size();
  sizeByRecords.set(count, bytes);
  addCase(`write/${count}`, "ms", samples, { records: count, repeats: REPEATS.write, sizeKb: round(bytes / 1024, 1) });
  addCase(
    `write/${count} per-record`,
    "ms/record",
    samples.map((ms) => ms / count),
    { records: count, note: "каждый замер записи, делённый на число записей" },
  );
  await dispose(storage);
}

/* ── 5. Чтение всей базы ───────────────────────── */
{
  const storage = newStorage();
  await storage.init();
  await storage.write(data);
  const samples = [];
  for (let i = 0; i < REPEATS.read; i++) {
    const { ms, value } = await timed(() => storage.read());
    if (!value || value.transactions.length !== MAX_RECORDS) {
      throw new Error("read() вернул неожиданный объём данных");
    }
    samples.push(ms);
  }
  addCase(`read/${MAX_RECORDS} (весь документ)`, "ms", samples, {
    records: MAX_RECORDS,
    repeats: REPEATS.read,
  });
  await dispose(storage);
}

/* ── 6. Точечный SQL-запрос по индексу даты ───────────────────────── */
let queryPlan = "";
{
  const storage = newStorage();
  await storage.init();
  await storage.write(data);

  const txTable = COLLECTION_SPECS.find((s) => s.collection === "transactions").table;
  // Реальные таблица и колонки из src/storage/schema.ts; индекс idx_transactions_date
  // создаётся миграцией (COLLECTION_SPECS[transactions].indexes содержит ["date"]).
  const pointSql = `SELECT "id", "date", "category", "amount" FROM "${txTable}" WHERE "date" = ? LIMIT ?`;

  // Берём самую заполненную дату, чтобы запрос возвращал строки, а не пустоту.
  const busiest = await storage.sql.query(
    `SELECT "date", COUNT(*) AS "n" FROM "${txTable}" GROUP BY "date" ORDER BY "n" DESC LIMIT 1`,
  );
  const busiestDate = String(busiest[0]?.date ?? isoDay(0));
  const limit = 50;

  const plan = await storage.sql.query(`EXPLAIN QUERY PLAN ${pointSql}`, [busiestDate, limit]);
  queryPlan = plan.map((r) => String(r.detail)).join("; ");

  const samples = [];
  let rows = 0;
  for (let i = 0; i < REPEATS.query; i++) {
    const { ms, value } = await timed(() => storage.sql.query(pointSql, [busiestDate, limit]));
    rows = value.length;
    samples.push(ms);
  }
  if (rows === 0) throw new Error("Точечный запрос вернул 0 строк — индекс/данные не в порядке");
  addCase(`query/point-by-date/${MAX_RECORDS}`, "ms", samples, {
    records: MAX_RECORDS,
    repeats: REPEATS.query,
    rows,
    date: busiestDate,
    sql: pointSql.replace(/\s+/g, " ").trim(),
    plan: queryPlan,
  });
  await dispose(storage);
}

/* ── 7. Размер базы ───────────────────────── */
{
  const storage = newStorage();
  await storage.init();
  await storage.write(data);
  const { ms, value: bytes } = await timed(() => storage.size());
  addCase(`size/${MAX_RECORDS}`, "KB", [bytes / 1024], {
    records: MAX_RECORDS,
    bytes,
    measuredMs: round(ms),
    bytesPerRecord: round(bytes / MAX_RECORDS, 1),
    growth: Object.fromEntries([...sizeByRecords].map(([n, b]) => [String(n), round(b / 1024, 1)])),
  });
  await dispose(storage);
}

/* ───────────────────────── вывод ───────────────────────── */

/** Ширина строки по кодовым точкам (кириллица — один символ). */
const width = (text) => [...String(text)].length;

const pad = (text, size) => {
  const str = String(text);
  const gap = size - width(str);
  return gap > 0 ? str + " ".repeat(gap) : str;
};

const UNIT_LABEL = {
  ms: "мс",
  "ms/record": "мс/запись",
  KB: "КБ",
};

const printTable = () => {
  const header = ["Случай", "Ед.", "Медиана", "Мин", "Макс", "Повт."];
  const rows = cases.map((c) => [
    c.name,
    UNIT_LABEL[c.unit] ?? c.unit,
    c.median.toFixed(c.unit === "KB" ? 1 : 3),
    c.min.toFixed(c.unit === "KB" ? 1 : 3),
    c.max.toFixed(c.unit === "KB" ? 1 : 3),
    String(c.samples.length),
  ]);
  const sizes = header.map((cell, i) => Math.max(width(cell), ...rows.map((r) => width(r[i]))));
  const line = (cells) => "  " + cells.map((cell, i) => pad(cell, sizes[i])).join("  ").trimEnd();
  const rule = "  " + sizes.map((s) => "-".repeat(s)).join("  ");

  console.log("");
  console.log(line(header));
  console.log(rule);
  for (const row of rows) console.log(line(row));
};

const cpus = os.cpus();
const cpuModel = (cpus[0]?.model ?? "unknown").trim();
const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  cases,
  environment: {
    platform: `${os.platform()} ${os.arch()}`,
    cpu: cpuModel,
    cpuCount: cpus.length,
    totalMemGb: round(os.totalmem() / 1024 ** 3, 1),
    schemaVersion: SCHEMA_VERSION,
    collections: COLLECTION_SPECS.length,
    indexes: COLLECTION_SPECS.reduce((n, s) => n + s.indexes.length, 0),
    sqlJs: sqlJsPkg.version,
    driver: "sql.js (WASM, in-memory) + снапшот в памяти",
    resolver: resolverKind,
    nodeFlags: [...process.execArgv],
    repeats: REPEATS,
    writeSizes: WRITE_SIZES,
    queryPlan,
  },
  notes: [
    "Абсолютные значения зависят от машины и нагрузки; сравнивать только прогоны на одном железе.",
    "cold-start/first-in-process — единственный замер: он включает загрузку sql.js и компиляцию WASM.",
    "write() внутри адаптера делает db.export() + сохранение снапшота, поэтому запись дороже чистого INSERT.",
    "query/point-by-date использует индекс idx_transactions_date (COLLECTION_SPECS -> transactions -> indexes).",
  ],
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log("=".repeat(96));
console.log(" Бенчмарк слоя хранения — sql.js (WASM) + SQLite  [ТЗ, Группа 5: время старта и задержка запросов]");
console.log("=".repeat(96));
console.log(` Node       : ${process.version}`);
console.log(` Платформа  : ${os.platform()} ${os.arch()}`);
console.log(` CPU        : ${cpuModel} (${cpus.length} ядер, ${round(os.totalmem() / 1024 ** 3, 1)} ГБ ОЗУ)`);
console.log(` Схема      : v${SCHEMA_VERSION} (${COLLECTION_SPECS.length} коллекций, ${COLLECTION_SPECS.reduce((n, s) => n + s.indexes.length, 0)} индексов)`);
console.log(` sql.js     : ${sqlJsPkg.version}, снапшот в памяти`);
console.log(` Резолвер   : ${resolverKind}, флаги: ${process.execArgv.join(" ") || "нет"}`);
printTable();
console.log("");
console.log(" План точечного запроса:");
console.log(`   ${queryPlan}`);
console.log("");
console.log(" Замеры повторяют структуру реального приложения, но идут в Node без Electron/WebView,");
console.log(" поэтому «холодный старт» здесь — это только слой хранения, а не время запуска окна.");
console.log("");
console.log(` Машиночитаемый отчёт: ${path.relative(ROOT, OUT_FILE).replace(/\\/g, "/")}`);
console.log(` Сгенерирован:         ${report.generatedAt}`);
