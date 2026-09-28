// src/storage/schema.ts
// Схема SQLite: по таблице на коллекцию AppData + служебная meta.
// Индексы — по полям, которые реально фильтруются в UI (ТЗ п. 5.3:
// не сканировать таблицу целиком), плюс колонка `doc` с полным JSON записи —
// она гарантирует Lossless round-trip при добавлении новых полей.
import type { CollectionKey, SqlOp } from "./types";

/** Версия схемы. Увеличивать при каждом изменении DDL. */
export const SCHEMA_VERSION = 1;

export const META_TABLE = "meta";
export const META_SETTINGS_KEY = "settings";
export const META_VERSION_KEY = "schema_version";

export interface ColumnSpec {
  name: string;
  /** SQL-тип вместе с NULL/NOT NULL. */
  type: string;
}

export interface CollectionSpec {
  collection: CollectionKey;
  table: string;
  columns: ColumnSpec[];
  /** Наборы колонок под индексы. */
  indexes: string[][];
}

export const COLLECTION_SPECS: CollectionSpec[] = [
  {
    collection: "transactions",
    table: "transactions",
    columns: [
      { name: "id", type: "TEXT PRIMARY KEY NOT NULL" },
      { name: "type", type: "TEXT NOT NULL" },
      { name: "category", type: "TEXT NOT NULL" },
      { name: "amount", type: "REAL NOT NULL" },
      { name: "description", type: "TEXT" },
      { name: "date", type: "TEXT NOT NULL" },
      { name: "source", type: "TEXT NOT NULL" },
      { name: "status", type: "TEXT NOT NULL" },
      { name: "sourceId", type: "TEXT" },
      { name: "createdAt", type: "TEXT NOT NULL" },
    ],
    indexes: [["date"], ["category"], ["status"], ["sourceId"], ["date", "category"]],
  },
  {
    collection: "subscriptions",
    table: "subscriptions",
    columns: [
      { name: "id", type: "TEXT PRIMARY KEY NOT NULL" },
      { name: "name", type: "TEXT NOT NULL" },
      { name: "amount", type: "REAL NOT NULL" },
      { name: "period", type: "TEXT NOT NULL" },
      { name: "billingDay", type: "INTEGER NOT NULL" },
      { name: "reminderDays", type: "INTEGER NOT NULL" },
      { name: "lastConfirmed", type: "TEXT" },
      { name: "createdAt", type: "TEXT NOT NULL" },
    ],
    indexes: [["billingDay"], ["period"]],
  },
  {
    collection: "fixedPayments",
    table: "fixed_payments",
    columns: [
      { name: "id", type: "TEXT PRIMARY KEY NOT NULL" },
      { name: "name", type: "TEXT NOT NULL" },
      { name: "amount", type: "REAL NOT NULL" },
      { name: "category", type: "TEXT NOT NULL" },
      { name: "payDay", type: "INTEGER NOT NULL" },
      { name: "autoPay", type: "INTEGER NOT NULL" },
      { name: "lastConfirmed", type: "TEXT" },
      { name: "createdAt", type: "TEXT NOT NULL" },
    ],
    indexes: [["payDay"], ["category"]],
  },
  {
    collection: "budgets",
    table: "budgets",
    columns: [
      { name: "id", type: "TEXT PRIMARY KEY NOT NULL" },
      { name: "category", type: "TEXT NOT NULL" },
      { name: "limit", type: "REAL NOT NULL" },
      { name: "createdAt", type: "TEXT NOT NULL" },
    ],
    indexes: [["category"]],
  },
  {
    collection: "goals",
    table: "goals",
    columns: [
      { name: "id", type: "TEXT PRIMARY KEY NOT NULL" },
      { name: "name", type: "TEXT NOT NULL" },
      { name: "targetAmount", type: "REAL NOT NULL" },
      { name: "savedAmount", type: "REAL NOT NULL" },
      { name: "deadline", type: "TEXT NOT NULL" },
      { name: "createdAt", type: "TEXT NOT NULL" },
    ],
    indexes: [["deadline"]],
  },
  {
    collection: "investments",
    table: "investments",
    columns: [
      { name: "id", type: "TEXT PRIMARY KEY NOT NULL" },
      { name: "ticker", type: "TEXT NOT NULL" },
      { name: "quantity", type: "REAL NOT NULL" },
      { name: "buyPrice", type: "REAL NOT NULL" },
      { name: "currentPrice", type: "REAL NOT NULL" },
      { name: "createdAt", type: "TEXT NOT NULL" },
    ],
    indexes: [["ticker"]],
  },
  {
    collection: "pendingPayments",
    table: "pending_payments",
    columns: [
      { name: "id", type: "TEXT PRIMARY KEY NOT NULL" },
      { name: "sourceType", type: "TEXT NOT NULL" },
      { name: "sourceId", type: "TEXT NOT NULL" },
      { name: "name", type: "TEXT NOT NULL" },
      { name: "amount", type: "REAL NOT NULL" },
      { name: "category", type: "TEXT NOT NULL" },
      { name: "dueDate", type: "TEXT NOT NULL" },
      { name: "createdAt", type: "TEXT NOT NULL" },
      { name: "status", type: "TEXT" },
      { name: "skippedCount", type: "INTEGER" },
      { name: "lastSkippedDate", type: "TEXT" },
      { name: "carryOverAmount", type: "REAL" },
    ],
    indexes: [["dueDate"], ["sourceId"], ["status"]],
  },
  {
    collection: "skippedPayments",
    table: "skipped_payments",
    columns: [
      { name: "id", type: "TEXT PRIMARY KEY NOT NULL" },
      { name: "sourceId", type: "TEXT NOT NULL" },
      { name: "sourceType", type: "TEXT NOT NULL" },
      { name: "originalAmount", type: "REAL NOT NULL" },
      { name: "skippedDate", type: "TEXT NOT NULL" },
      { name: "dueDate", type: "TEXT NOT NULL" },
      { name: "carryOver", type: "INTEGER NOT NULL" },
      { name: "carriedAmount", type: "REAL NOT NULL" },
    ],
    indexes: [["skippedDate"], ["sourceId"]],
  },
];

const q = (id: string): string => `"${id}"`;

/** Значения, которые SQLite понимает: boolean → 0/1, Date → ISO, BLOB → как есть. */
export function toSqlValue(value: unknown): string | number | null | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value;
  // Бинарные данные нельзя прогонять через JSON.stringify — нативные драйверы
  // (better-sqlite3, tauri-plugin-sql) принимают Uint8Array напрямую.
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

export const metaSchemaOps = (): SqlOp[] => [
  // NOT NULL в первичном ключе: в SQLite NULL в PRIMARY KEY разрешён, и такая
  // строка не нашлась бы ни по одному `WHERE id = ?`.
  { sql: `CREATE TABLE IF NOT EXISTS ${q(META_TABLE)} (${q("key")} TEXT PRIMARY KEY NOT NULL, ${q("value")} TEXT NOT NULL)` },
];

export const createTableOps = (spec: CollectionSpec): SqlOp[] => {
  const cols = [...spec.columns.map((c) => `${q(c.name)} ${c.type}`), `${q("doc")} TEXT NOT NULL`];
  const ops: SqlOp[] = [
    { sql: `CREATE TABLE IF NOT EXISTS ${q(spec.table)} (\n  ${cols.join(",\n  ")}\n)` },
  ];
  for (const idx of spec.indexes) {
    const name = `idx_${spec.table}_${idx.join("_")}`;
    ops.push({
      sql: `CREATE INDEX IF NOT EXISTS ${q(name)} ON ${q(spec.table)} (${idx.map(q).join(", ")})`,
    });
  }
  return ops;
};

/** UPSERT строки: id в PK, остальные колонки и `doc` обновляются. */
export const upsertRowOp = (spec: CollectionSpec, row: Record<string, unknown>): SqlOp => ({
  sql: upsertSql(spec),
  params: upsertParams(spec, row),
});

/** SQL Upsert для коллекции (один и тот же для пачки строк). */
export const upsertSql = (spec: CollectionSpec): string => {
  const names = [...spec.columns.map((c) => c.name), "doc"];
  const placeholders = names.map(() => "?").join(", ");
  const updatable = spec.columns
    .filter((c) => c.name !== "id")
    .map((c) => `${q(c.name)} = excluded.${q(c.name)}`)
    .join(", ");
  return (
    `INSERT INTO ${q(spec.table)} (${names.map(q).join(", ")}) VALUES (${placeholders}) ` +
    `ON CONFLICT(${q("id")}) DO UPDATE SET ${updatable}, ${q("doc")} = excluded.${q("doc")}`
  );
};

const upsertParams = (spec: CollectionSpec, row: Record<string, unknown>): unknown[] => [
  ...spec.columns.map((c) => toSqlValue(row[c.name])),
  JSON.stringify(row),
];

/**
 * Пачка строк для одного prepared statement: драйвер готовит запрос один раз
 * и выполняет его для каждой строки. На больших коллекциях это заметно быстрее,
 * чем exec на каждую запись.
 */
export const upsertRowsOp = (
  spec: CollectionSpec,
  rows: Record<string, unknown>[],
): { sql: string; rows: unknown[][] } => ({
  sql: upsertSql(spec),
  rows: rows.map((row) => upsertParams(spec, row)),
});

export const deleteRowsOp = (table: string, ids: string[]): SqlOp => {
  // Пустой список в `IN ()` — синтаксическая ошибка SQL. Отдаём безопасный
  // no-op, чтобы забытая проверка не роняла всю транзакцию.
  if (ids.length === 0) return { sql: "SELECT 1 WHERE 0", params: [] };
  return {
    sql: `DELETE FROM ${q(table)} WHERE ${q("id")} IN (${ids.map(() => "?").join(", ")})`,
    params: [...ids],
  };
};

export const deleteAllRowsOp = (table: string): SqlOp => ({ sql: `DELETE FROM ${q(table)}` });

export const readRowsSql = (table: string): string => `SELECT ${q("doc")} FROM ${q(table)}`;
export const readIdsSql = (table: string): string => `SELECT ${q("id")} FROM ${q(table)}`;

export const setMetaOp = (key: string, value: string): SqlOp => ({
  sql:
    `INSERT INTO ${q(META_TABLE)} (${q("key")}, ${q("value")}) VALUES (?, ?) ` +
    `ON CONFLICT(${q("key")}) DO UPDATE SET ${q("value")} = excluded.${q("value")}`,
  params: [key, value],
});

/** Ключ meta подставляется параметром: ${q("key")} = ? */
export const READ_META_SQL = `SELECT ${q("value")} FROM ${q(META_TABLE)} WHERE ${q("key")} = ?`;

export interface MigrationStep {
  version: number;
  name: string;
  ops: () => SqlOp[];
}

/**
 * Шаги миграций по версиям. Каждый шаг идемпотентен (IF NOT EXISTS),
 * поэтому шаг можно применить повторно без риска.
 */
export const MIGRATIONS: MigrationStep[] = [
  {
    version: 1,
    name: "base-schema",
    ops: () => [...metaSchemaOps(), ...COLLECTION_SPECS.flatMap(createTableOps)],
  },
];

export const migrationOps = (fromVersion: number, toVersion: number): SqlOp[] =>
  MIGRATIONS.filter((m) => m.version > fromVersion && m.version <= toVersion)
    .sort((a, b) => a.version - b.version)
    .flatMap((m) => m.ops());

/** Полный DDL с нуля (используется в тестах и при повреждённой базе). */
export const fullSchemaOps = (): SqlOp[] => [
  ...metaSchemaOps(),
  ...COLLECTION_SPECS.flatMap(createTableOps),
  setMetaOp(META_VERSION_KEY, String(SCHEMA_VERSION)),
];
