// src/storage/index.ts
// Точка входа слоя хранения: выбирает драйвер, поднимает его один раз
// и выполняет миграцию наследия. Приложение работает только через getStorage().
import { MemoryStorage } from "./memory";
import {
  legacyBackupStatus,
  migrateLegacyData,
  purgeLegacySource,
  type LegacyBackupStatus,
  type MigrationReport,
  type MigrationStatus,
} from "./migrate";
import { createSnapshotStore } from "./snapshots";
import { SqliteStorage, browserSqlJsLoader, type SqlJsLoader } from "./sqlite";
import type { StorageAdapter, StorageDriverName } from "./types";

let pending: Promise<StorageAdapter> | null = null;
let report: MigrationReport | null = null;
let legacyBackupInfo: LegacyBackupStatus | null = null;
let sqliteError: string | null = null;

/** Создаёт адаптер: SQLite, а при неудаче — память (приложение остаётся рабочим). */
export async function createStorageAdapter(load?: SqlJsLoader): Promise<StorageAdapter> {
  try {
    const storage = new SqliteStorage({
      snapshots: createSnapshotStore(),
      ...(load ? { load } : { load: browserSqlJsLoader }),
    });
    await storage.init();
    sqliteError = null;
    return storage;
  } catch (err) {
    sqliteError = (err as Error).message;
    console.error("[storage] SQLite недоступен, работаем в памяти:", err);
    const fallback = new MemoryStorage();
    await fallback.init();
    return fallback;
  }
}

/** Ленивая инициализация + однократная миграция наследия. */
export function getStorage(): Promise<StorageAdapter> {
  if (!pending) {
    pending = (async () => {
      const adapter = await createStorageAdapter();
      report = await migrateLegacyData(adapter);
      // Срок отката на исходные данные (ТЗ п. 3.2) истекает через 30 дней.
      legacyBackupInfo = await legacyBackupStatus(adapter);
      await purgeLegacySource(adapter).catch(() => undefined);
      return adapter;
    })();
    // Отклонённый промис не должен ломать старт навсегда: при ошибке
    // следующий вызов попробует снова (иначе приложение не поднимется).
    pending.catch(() => {
      pending = null;
    });
  }
  return pending;
}

/** Сброс кэша адаптера (тесты, смена окружения). */
export function resetStorage(): void {
  pending = null;
  report = null;
  legacyBackupInfo = null;
  sqliteError = null;
}

export function migrationReport(): MigrationReport | null {
  return report;
}

export function migrationStatus(): MigrationStatus | null {
  return report?.status ?? null;
}

/** Резервная копия наследия в localStorage и срок её жизни (для настроек). */
export function legacyBackup(): LegacyBackupStatus | null {
  return legacyBackupInfo;
}

export function sqliteInitError(): string | null {
  return sqliteError;
}

export interface StorageDescription {
  driver: StorageDriverName;
  persistent: boolean;
  version: number;
  bytes: number;
  journalMode: string;
  path: string;
  status: string;
  migration: MigrationStatus | null;
  /** База не прочиталась при старте — данные на месте, но не загружены. */
  readError: string | null;
  /** Последняя запись снапшота не удалась. */
  persistError: string | null;
  /** База из более новой версии: запись отключена. */
  locked: string | null;
  /** Резервная копия наследия: сколько дней осталось на откат. */
  legacyBackup: LegacyBackupStatus | null;
}

const pathOf = (driver: StorageDriverName): string => {
  if (driver === "memory") return "оперативная память (сеанс)";
  // Путь отражает реально созданное хранилище снапшота, а не предположение.
  switch (createSnapshotStore().kind) {
    case "file":
      return "Файл nexus-data.sqlite в папке данных приложения";
    case "indexeddb":
      return "indexeddb://nexus-finance/db.sqlite";
    case "localstorage":
      return "localStorage://nexus.sqlite.snapshot (запасной вариант)";
    default:
      return "оперативная память (сеанс)";
  }
};

/** Сводка для экрана настроек. */
export async function describeStorage(): Promise<StorageDescription> {
  const adapter = await getStorage();
  const [version, bytes] = await Promise.all([adapter.version(), adapter.size()]);
  const status = adapter instanceof SqliteStorage ? adapter.status : null;
  const persistError = status?.persistError ?? null;
  return {
    driver: adapter.driver,
    persistent: adapter.persistent,
    version,
    bytes,
    journalMode: adapter.sql?.journalMode() ?? "n/a",
    path: pathOf(adapter.driver),
    status: persistError
      ? "Последняя запись не удалась — хранилище считается временным"
      : adapter.persistent
        ? "Данные в SQLite — переживают перезапуск и чистку кэша"
        : "Данные во временном хранилище — сохраните резервную копию",
    migration: report?.status ?? null,
    readError: status?.readError ?? null,
    persistError,
    locked: status?.locked ?? null,
    legacyBackup: legacyBackupInfo,
  };
}

export * from "./types";
export { MemoryStorage } from "./memory";
export { SqliteStorage, browserSqlJsLoader } from "./sqlite";
export type { SqlJsLoader } from "./sqlite";
export { LEGACY_KEEP_DAYS, LEGACY_MIGRATION_FLAG, legacyBackupStatus, migrateLegacyData, purgeLegacySource, readLegacySource } from "./migrate";
export type { LegacyBackupStatus, MigrationReport, MigrationStatus } from "./migrate";
export { createSnapshotStore, ElectronSnapshotStore, IndexedDbSnapshotStore, LocalStorageSnapshotStore, MemorySnapshotStore } from "./snapshots";
export { COLLECTION_SPECS, SCHEMA_VERSION } from "./schema";
