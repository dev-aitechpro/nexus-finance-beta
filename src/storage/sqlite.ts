// src/storage/sqlite.ts
// SQLite-адаптер: sql.js (WASM) + персистентный снапшот БД.
// Тот же контракт закрывает и нативные реализации из ТЗ:
// better-sqlite3 (Windows) и tauri-plugin-sql (Tauri) — меняется только SqlDriver.
import type { Database, SqlJsStatic } from "sql.js";
import { emptyData } from "../lib/engine";
import type { AppData } from "../lib/types";
import { LEGACY_MIGRATED_AT_FLAG, LEGACY_MIGRATION_FLAG } from "./migrate";
import {
  COLLECTION_SPECS,
  META_SETTINGS_KEY,
  META_TABLE,
  META_VERSION_KEY,
  SCHEMA_VERSION,
  deleteAllRowsOp,
  deleteRowsOp,
  migrationOps,
  READ_META_SQL,
  readIdsSql,
  readRowsSql,
  setMetaOp,
  toSqlValue,
  upsertRowsOp,
} from "./schema";
import type { CollectionKey, SnapshotStore, SqlDriver, SqlOp, StorageAdapter } from "./types";

/** Загрузчик sql.js. В Node (тесты) передаётся свой — с чтением WASM с диска. */
export type SqlJsLoader = (config: Record<string, unknown>) => Promise<SqlJsStatic>;

const base64ToBytes = (dataUrl: string): Uint8Array => {
  const comma = dataUrl.indexOf(",");
  const bin = atob(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/**
 * Браузерный/Electron-загрузчик. Сначала пробуем WASM, при неудаче — asm-сборку
 * (медленнее, но не требует бинарника и сетевых запросов).
 */
export const browserSqlJsLoader: SqlJsLoader = async (config) => {
  try {
    const [{ default: initWasm }, { default: wasmInline }] = await Promise.all([
      import("sql.js/dist/sql-wasm.js"),
      import("./wasmAsset"),
    ]);
    return initWasm({ ...config, wasmBinary: base64ToBytes(wasmInline) });
  } catch (err) {
    console.warn("[storage] sql.js/wasm недоступен, fallback на asm:", err);
    const { default: initAsm } = await import("sql.js/dist/sql-asm.js");
    return initAsm(config);
  }
};

const isReadStatement = (sql: string): boolean => /^\s*(select|with|pragma)/i.test(sql);

const DELETE_CHUNK = 400;

/** Драйвер SQL-уровня поверх sql.js. */
export class SqliteSqlDriver implements SqlDriver {
  readonly name = "sqlite" as const;

  private db: Database | null = null;
  private SQL: SqlJsStatic | null = null;
  private depth = 0;

  constructor(private readonly load: SqlJsLoader = browserSqlJsLoader) {}

  async init(): Promise<void> {
    if (this.db) return;
    this.SQL = await this.load({});
    this.db = new this.SQL.Database();
    this.applyPragmas();
  }

  async reinit(): Promise<void> {
    await this.close();
    await this.init();
  }

  private applyPragmas(): void {
    const db = this.require();
    // WAL даёт параллельные чтения при записи (ТЗ п. 3.3). В in-memory сборке
    // sql.js режим остаётся "memory" — это ожидаемо и проверяется тестом.
    try {
      db.run("PRAGMA journal_mode = WAL");
    } catch {
      /* in-memory БД не поддерживает WAL */
    }
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA temp_store = MEMORY");
  }

  private require(): Database {
    if (!this.db) throw new Error("SQLite: драйвер не инициализирован");
    return this.db;
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const db = this.require();
    const stmt = db.prepare(sql);
    try {
      if (params.length) stmt.bind(params.map((p) => toSqlValue(p) as never));
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      return rows;
    } finally {
      stmt.free();
    }
  }

  async exec(sql: string, params: unknown[] = []): Promise<void> {
    const db = this.require();
    if (params.length) db.run(sql, params.map((p) => toSqlValue(p) as never));
    else db.run(sql);
  }

  /**
   * Много строк одним prepared statement: prepare делается один раз,
   * строки bind/step/reset идут циклом. На больших коллекциях это в разы
   * дешевле, чем exec на каждую строку.
   */
  async runBatch(sql: string, rows: unknown[][]): Promise<void> {
    if (rows.length === 0) return;
    const db = this.require();
    const stmt = db.prepare(sql);
    try {
      for (const params of rows) {
        stmt.reset();
        stmt.bind(params.map((p) => toSqlValue(p) as never));
        stmt.step();
      }
    } finally {
      stmt.free();
    }
  }

  async transaction<T = Record<string, unknown>>(ops: SqlOp[]): Promise<T[]> {
    const db = this.require();
    const nested = this.depth > 0;
    const savepoint = `sp_${this.depth}`;
    db.run(nested ? `SAVEPOINT ${savepoint}` : "BEGIN");
    this.depth++;
    try {
      const results: T[] = [];
      for (const op of ops) {
        if (isReadStatement(op.sql)) results.push(...(await this.query<T>(op.sql, op.params ?? [])));
        else await this.exec(op.sql, op.params ?? []);
      }
      this.depth--;
      db.run(nested ? `RELEASE ${savepoint}` : "COMMIT");
      return results;
    } catch (err) {
      this.depth--;
      try {
        db.run(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
      } catch {
        /* транзакция уже свёрнута */
      }
      throw err;
    }
  }

  async migrate(fromVersion: number, toVersion: number): Promise<void> {
    if (toVersion <= fromVersion) return;
    await this.transaction([...migrationOps(fromVersion, toVersion), setMetaOp(META_VERSION_KEY, String(toVersion))]);
  }

  journalMode(): string {
    const res = this.require().exec("PRAGMA journal_mode");
    return String(res[0]?.values?.[0]?.[0] ?? "unknown").toLowerCase();
  }

  async export(): Promise<Uint8Array | null> {
    return this.require().export();
  }

  async import(bytes: Uint8Array): Promise<void> {
    if (!this.SQL) await this.init();
    this.db?.close();
    this.db = new this.SQL!.Database(bytes);
    this.depth = 0;
    this.applyPragmas();
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}

export interface SqliteStorageOptions {
  snapshots: SnapshotStore;
  load?: SqlJsLoader;
}

/** Документный адаптер поверх SqliteSqlDriver. */
export class SqliteStorage implements StorageAdapter {
  readonly driver = "sqlite" as const;
  readonly sql: SqlDriver;

  private readonly snapshots: SnapshotStore;
  private bootstrap: Promise<void> | null = null;
  private txDepth = 0;
  private lastBytes = 0;
  /** Очередь операций: SQLite допускает только одну активную транзакцию. */
  private queue: Promise<unknown> = Promise.resolve();
  private scope: StorageAdapter | null = null;
  /** Последняя попытка записать снапшот удалась? */
  private lastPersistOk = true;
  private lastPersistError: string | null = null;
  /** Сохранённая база не прочиталась при старте. */
  private readError: string | null = null;
  /** База создана более новой версией приложения — писать в неё нельзя. */
  private locked: string | null = null;

  constructor(options: SqliteStorageOptions) {
    this.snapshots = options.snapshots;
    this.sql = new SqliteSqlDriver(options.load ?? browserSqlJsLoader);
  }

  /**
   * Данные переживают перезапуск только если снапшот действительно пишется
   * в постоянное хранилище и последняя запись удалась. Иначе приложение
   * честно показывает «временное хранилище», а не обещает надёжность.
   */
  get persistent(): boolean {
    if (this.snapshots.kind === "memory") return false;
    return this.lastPersistOk;
  }

  /** Диагностика для экрана настроек. */
  get status(): { persistError: string | null; readError: string | null; locked: string | null } {
    return { persistError: this.lastPersistError, readError: this.readError, locked: this.locked };
  }

  init(): Promise<void> {
    if (!this.bootstrap) {
      this.bootstrap = this.open().catch((err) => {
        // Неудачное открытие не должно «прибивать» хранилище до конца сессии:
        // следующий вызов init() попробует ещё раз (важно и для тестов).
        this.bootstrap = null;
        throw err;
      });
    }
    return this.bootstrap;
  }

  private async open(): Promise<void> {
    // null — базы ещё нет (первый запуск), исключение — база есть, но не
    // читается. Это разные ситуации: во втором случае нельзя молча начинать
    // с нуля, иначе автосохранение затрёт файл.
    let bytes: Uint8Array | null = null;
    try {
      bytes = await this.snapshots.load();
    } catch (err) {
      this.readError = (err as Error).message;
      this.lastPersistOk = false;
      console.error("[storage] сохранённая база не прочитана:", err);
    }
    await this.sql.init();
    if (bytes && bytes.length > 0) {
      try {
        await this.sql.import(bytes);
        this.lastBytes = bytes.byteLength;
      } catch (err) {
        // Битый снапшот не должен ронять приложение: начинаем с чистой базы.
        console.warn("[storage] снапшот повреждён, начинаем с нуля:", err);
        await this.sql.reinit();
      }
    }
    const current = await this.readVersion();
    if (current > SCHEMA_VERSION) {
      // База из более новой версии: читать можно, писать нельзя, иначе
      // старый DDL разъедется с миграциями новой версии.
      this.locked =
        `База создана более новой версией приложения (схема ${current} > ${SCHEMA_VERSION}). ` +
        "Запись отключена, данные не изменяются.";
      console.error("[storage]", this.locked);
      return;
    }
    if (current < SCHEMA_VERSION) await this.sql.migrate(current, SCHEMA_VERSION);
  }

  private async readVersion(): Promise<number> {
    try {
      const rows = await this.sql.query<{ value: string }>(READ_META_SQL, [META_VERSION_KEY]);
      const parsed = Number.parseInt(rows[0]?.value ?? "0", 10);
      return Number.isFinite(parsed) ? parsed : 0;
    } catch {
      return 0;
    }
  }

  async version(): Promise<number> {
    await this.init();
    return this.readVersion();
  }

  async getFlag(key: string): Promise<string | null> {
    await this.init();
    const rows = await this.sql.query<{ value: string }>(READ_META_SQL, [key]);
    return rows[0]?.value ?? null;
  }

  async setFlag(key: string, value: string): Promise<void> {
    await this.init();
    this.assertWritable();
    // Внутри транзакции — напрямую (снапшот сохранит внешняя), снаружи — в очередь.
    if (this.txDepth > 0) return this.execFlag(key, value);
    return this.enqueue(async () => {
      await this.execFlag(key, value);
      await this.persist();
    });
  }

  private async execFlag(key: string, value: string): Promise<void> {
    const op = setMetaOp(key, value);
    await this.sql.exec(op.sql, op.params ?? []);
  }

  /** true, если мы внутри явной транзакции. */
  get inTransaction(): boolean {
    return this.txDepth > 0;
  }

  async read(): Promise<AppData | null> {
    await this.init();
    const out = emptyData();
    let rows = 0;
    for (const spec of COLLECTION_SPECS) {
      const docs = await this.sql.query<{ doc: string }>(readRowsSql(spec.table));
      let broken = 0;
      (out as unknown as Record<string, unknown>)[spec.collection] = docs
        .map((r) => this.parseDoc(r.doc))
        .filter((x): x is Record<string, unknown> => {
          if (x !== null) return true;
          broken++;
          return false;
        });
      // Потерянные документы не должны исчезать молча: сообщаем один раз.
      if (broken > 0) {
        console.error(`[storage] таблица ${spec.table}: не удалось разобрать ${broken} записей`);
      }
      rows += docs.length;
    }
    const settings = await this.sql.query<{ value: string }>(READ_META_SQL, [META_SETTINGS_KEY]);
    if (settings[0]) this.applySettings(out, settings[0].value);
    return rows > 0 || settings.length > 0 ? out : null;
  }

  async write(data: AppData): Promise<boolean> {
    await this.init();
    this.assertWritable();
    // Ключевой момент: запись обязана идти через ту же очередь, что и
    // transaction(). Иначе два автосохранения, идущие следом друг за другом,
    // окажутся в одной незавершённой транзакции: чужой ROLLBACK откатит уже
    // возвращённый вызову «true» результат, а удаление устаревших строк
    // может снести только что записанные данные.
    if (this.txDepth > 0) return this.writeInTransaction(data);
    return this.enqueue(() => this.writeInTransaction(data));
  }

  private async writeInTransaction(data: AppData): Promise<boolean> {
    return this.runTransaction(async (tx) => {
      for (const spec of COLLECTION_SPECS) {
        const raw = (data[spec.collection] ?? []) as unknown as Record<string, unknown>[];
        // Запись без строкового id нельзя ни найти, ни удалить — она
        // размножалась бы при каждом сохранении. Отбрасываем её явно.
        const items = raw.filter((i) => typeof i?.id === "string" && i.id.length > 0);
        if (items.length !== raw.length) {
          console.error(`[storage] ${spec.collection}: пропущено ${raw.length - items.length} записей без id`);
        }
        const existing = (await tx.sql!.query<{ id: string }>(readIdsSql(spec.table))).map((r) => r.id);
        const keep = new Set(items.map((i) => String(i.id)));
        const stale = existing.filter((id) => !keep.has(id));
        for (let i = 0; i < stale.length; i += DELETE_CHUNK) {
          const op = deleteRowsOp(spec.table, stale.slice(i, i + DELETE_CHUNK));
          await tx.sql!.exec(op.sql, op.params ?? []);
        }
        if (items.length > 0) {
          const batch = upsertRowsOp(spec, items);
          if (tx.sql!.runBatch) {
            // Один prepare на коллекцию вместо prepare на каждую строку.
            await tx.sql!.runBatch(batch.sql, batch.rows);
          } else {
            for (const row of batch.rows) await tx.sql!.exec(batch.sql, row);
          }
        }
      }
      const settings = {
        currency: data.currency,
        theme: data.theme,
        fontScale: data.fontScale,
      };
      const op = setMetaOp(META_SETTINGS_KEY, JSON.stringify(settings));
      await tx.sql!.exec(op.sql, op.params ?? []);
      return true;
    });
  }

  async clear(): Promise<void> {
    await this.init();
    this.assertWritable();
    const run = async (): Promise<void> => {
      await this.runTransaction(async (tx) => {
        for (const spec of COLLECTION_SPECS) await tx.sql!.exec(deleteAllRowsOp(spec.table).sql);
        // Флаги миграции legacy НАДО сохранить: если их удалить, то при
        // следующем запуске миграция снова прочитает старый ключ из
        // localStorage и вернёт только что удалённые данные. Остальные
        // служебные отметки (например, «онбординг показан») удаляются —
        // очистка данных должна возвращать приложение в исходное состояние.
        await tx.sql!.exec(
          `DELETE FROM "${META_TABLE}" WHERE "key" NOT IN (?, ?, ?, ?)`,
          [META_VERSION_KEY, META_SETTINGS_KEY, LEGACY_MIGRATION_FLAG, LEGACY_MIGRATED_AT_FLAG],
        );
      });
      this.lastBytes = 0;
      // После удаления всех данных сразу сжимаем базу: иначе файл остаётся
      // прежнего размера (ТЗ п. 3.3).
      await this.compactNow();
    };
    if (this.txDepth > 0) return run();
    return this.enqueue(run);
  }

  async size(): Promise<number> {
    await this.init();
    if (this.txDepth > 0) return this.lastBytes;
    // Размер считаем через PRAGMA, а не через db.export(): экспорт закрывает
    // и пересобирает образ всей БД, а он тут совсем не нужен.
    try {
      const [pages, pageSize] = await Promise.all([
        this.sql.query<Record<string, unknown>>("PRAGMA page_count"),
        this.sql.query<Record<string, unknown>>("PRAGMA page_size"),
      ]);
      const count = Number(pages[0]?.page_count ?? 0);
      const size = Number(pageSize[0]?.page_size ?? 0);
      if (count > 0 && size > 0) {
        this.lastBytes = count * size;
        return this.lastBytes;
      }
    } catch {
      /* кладем ниже на экспорт */
    }
    if (this.lastBytes === 0) {
      const bytes = await this.sql.export();
      this.lastBytes = bytes?.byteLength ?? 0;
    }
    return this.lastBytes;
  }

  /**
   * Ставит операцию в очередь: пока не завершена предыдущая, следующая
   * не начинается. Так все записи, очистки и транзакции идут строго по очереди.
   */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Транзакции выполняются по очереди: параллельные вызовы не могут
   * начать вторую BEGIN, пока первая не закоммичена.
   */
  async transaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> {
    // Вложенный вызов идёт сразу (savepoint), иначе внешняя транзакция
    // ждала бы саму себя в очереди.
    if (this.txDepth > 0) return this.runTransaction(fn);
    return this.enqueue(() => this.runTransaction(fn));
  }

  /**
   * Сжатие базы (VACUUM). VACUUM нельзя выполнять внутри транзакции и он
   * пересобирает весь образ БД, поэтому после него нужен новый снапшот.
   * В очередь он попадает через enqueue(), а из clear() вызывается напрямую
   * (compactNow), иначе он встал бы в очередь за самим собой.
   */
  async compact(): Promise<void> {
    await this.init();
    return this.enqueue(() => this.compactNow());
  }

  private async compactNow(): Promise<void> {
    if (this.txDepth > 0) return;
    await this.sql.exec("VACUUM");
    this.lastBytes = 0;
    await this.persist();
    await this.size();
  }

  private assertWritable(): void {
    if (this.locked) throw new Error(`[storage] ${this.locked}`);
  }

  private async runTransaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> {
    await this.init();
    if (this.txDepth === 0) await this.sql.exec("BEGIN");
    this.txDepth++;
    try {
      const result = await fn(this.scoped());
      this.txDepth--;
      if (this.txDepth === 0) {
        await this.sql.exec("COMMIT");
        await this.persist();
      }
      return result;
    } catch (err) {
      this.txDepth--;
      if (this.txDepth === 0) {
        try {
          await this.sql.exec("ROLLBACK");
        } catch {
          /* уже свёрнуто */
        }
      }
      throw err;
    }
  }

  /**
   * Представление адаптера внутри транзакции: вложенный transaction()
   * выполняется сразу (savepoint), а не становится в очередь — иначе
   * внешняя транзакция ждала бы саму себя.
   */
  private scoped(): StorageAdapter {
    const owner = this;
    this.scope ??= {
      driver: "sqlite",
      get persistent(): boolean {
        return owner.persistent;
      },
      sql: this.sql,
      init: () => this.init(),
      read: () => this.read(),
      write: (data: AppData) => this.write(data),
      clear: () => this.clear(),
      size: () => this.size(),
      version: () => this.version(),
      getFlag: (key: string) => this.getFlag(key),
      setFlag: (key: string, value: string) => this.setFlag(key, value),
      compact: () => this.compactNow(),
      transaction: <T,>(fn: (tx: StorageAdapter) => Promise<T>) => this.runTransaction(fn),
    };
    return this.scope;
  }

  private async persist(): Promise<void> {
    // Внутри транзакции экспорт недопустим: db.export() закрывает её.
    // Снапшот сохранит внешняя транзакция сразу после COMMIT.
    if (this.txDepth > 0) return;
    const bytes = await this.sql.export();
    if (!bytes) return;
    this.lastBytes = bytes.byteLength;
    try {
      await this.snapshots.save(bytes);
      this.lastPersistOk = true;
      this.lastPersistError = null;
    } catch (err) {
      // Ошибку записи нельзя проглатывать: данные в памяти есть, но на диск
      // они не попали. Помечаем хранилище временным и отдаём текст ошибки
      // в настройки — иначе пользователь увидит ложное «сохранено».
      this.lastPersistOk = false;
      this.lastPersistError = (err as Error).message;
      console.error("[storage] не удалось сохранить снапшот БД:", err);
    }
  }

  private parseDoc(doc: unknown): Record<string, unknown> | null {
    if (typeof doc !== "string") return null;
    try {
      const parsed = JSON.parse(doc) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private applySettings(data: AppData, raw: string): void {
    try {
      const parsed = JSON.parse(raw) as Partial<AppData>;
      if (parsed.currency) data.currency = parsed.currency;
      if (parsed.theme) data.theme = parsed.theme;
      if (typeof parsed.fontScale === "number") data.fontScale = parsed.fontScale;
    } catch {
      /* настройки не критичны */
    }
  }
}

export type { CollectionKey };
