// src/storage/types.ts
// Контракты слоя хранения (ТЗ «Техническое задание1.md», п. 3.1).
//
// Приложение знает только StorageAdapter (документный уровень).
// Реализации деталей (SQLite / память / файл) скрыты внутри адаптера,
// поэтому верхний код не зависит от платформы и хранилища.
import type { AppData } from "../lib/types";

/** sqlite — надёжное файловое/IDB-хранилище, memory — тесты и деградация. */
export type StorageDriverName = "sqlite" | "memory";

/** Коллекции AppData, которые раскладываются по отдельным таблицам. */
export type CollectionKey =
  | "transactions"
  | "subscriptions"
  | "fixedPayments"
  | "budgets"
  | "goals"
  | "investments"
  | "pendingPayments"
  | "skippedPayments";

/** Одна SQL-операция для транзакции. */
export interface SqlOp {
  sql: string;
  params?: unknown[];
}

/**
 * SQL-уровень. Реализации: sql.js (Web/Electron), better-sqlite3 (нативный
 * Windows-клиент), tauri-plugin-sql (Tauri), react-native-sqlite-storage (Android).
 */
export interface SqlDriver {
  readonly name: StorageDriverName;
  /** Открыть соединение и применить PRAGMA (journal_mode, synchronous, foreign_keys). */
  init(): Promise<void>;
  /** Пересоздать пустое соединение (после неудачного импорта снапшота). */
  reinit(): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string, params?: unknown[]): Promise<void>;
  /**
   * Оптимизация для массовой записи: один prepare на пачку строк.
   * Необязательна — адаптер использует её, если драйвер её умеет.
   */
  runBatch?(sql: string, rows: unknown[][]): Promise<void>;
  /** Атомарная пачка операций: BEGIN/COMMIT, при ошибке ROLLBACK. */
  transaction<T = Record<string, unknown>>(ops: SqlOp[]): Promise<T[]>;
  /** Миграции схемы fromVersion → toVersion внутри одной транзакции. */
  migrate(fromVersion: number, toVersion: number): Promise<void>;
  /** Текущий режим журнала: wal | memory | delete. */
  journalMode(): string;
  /** Снапшот БД для персистентности. */
  export(): Promise<Uint8Array | null>;
  import(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** Где физически лежит снапшот БД — показывается в настройках. */
export type SnapshotKind = "file" | "indexeddb" | "localstorage" | "memory";

/** Куда складывать снапшот БД (IndexedDB / файл Electron / память). */
export interface SnapshotStore {
  /** Тип хранилища: по нему адаптер честно определяет durable-режим. */
  readonly kind: SnapshotKind;
  load(): Promise<Uint8Array | null>;
  save(bytes: Uint8Array): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Документный уровень — единственный API, который использует приложение.
 * read/write работают с целым AppData: состояние приложения уже держится в памяти,
 * а слой хранения отвечает за надёжность, атомарность и запросы.
 */
export interface StorageAdapter {
  readonly driver: StorageDriverName;
  /** true, если данные переживают перезапуск и очистку кэша WebView. */
  readonly persistent: boolean;
  /** SQL-доступ есть только у драйверов с реальной БД. */
  readonly sql?: SqlDriver;
  init(): Promise<void>;
  read(): Promise<AppData | null>;
  write(data: AppData): Promise<boolean>;
  clear(): Promise<void>;
  /** Размер хранилища, байты. */
  size(): Promise<number>;
  /** Версия схемы. */
  version(): Promise<number>;
  /** Служебные флаги хранилища (миграции, отметки). */
  getFlag(key: string): Promise<string | null>;
  setFlag(key: string, value: string): Promise<void>;
  /**
   * Сжать базу (VACUUM): после массового удаления файл сам не уменьшается,
   * освобождённые страницы остаются в нём (ТЗ п. 3.3).
   */
  compact(): Promise<void>;
  /** Атомарная операция: при ошибке состояние не меняется. */
  transaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T>;
}
