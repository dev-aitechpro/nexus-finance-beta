// src/storage/memory.ts
// Адаптер в памяти: тесты, деградация, если SQLite недоступен.
// Транзакции реализованы через снимок состояния — при ошибке откат,
// как и в SQLite (ТЗ п. 3.1, п. 3.3).
import { emptyData } from "../lib/engine";
import type { AppData } from "../lib/types";
import { COLLECTION_SPECS, SCHEMA_VERSION } from "./schema";
import type { StorageAdapter } from "./types";

export interface MemoryStorageOptions {
  initial?: AppData | null;
  /** Хук для тестов: бросить ошибку перед записью (проверка отката). */
  onBeforeWrite?: (data: AppData) => void;
  /** Считать, что данные сохраняются (иначе adapter.persistent = false). */
  persistent?: boolean;
}

const clone = <T>(value: T): T => (value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)) as T);

export class MemoryStorage implements StorageAdapter {
  readonly driver = "memory" as const;
  readonly persistent: boolean;

  private data: AppData;
  private flags = new Map<string, string>();
  private txDepth = 0;
  private backup: AppData | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private versionValue: number;

  constructor(private readonly options: MemoryStorageOptions = {}) {
    this.persistent = options.persistent ?? false;
    this.versionValue = SCHEMA_VERSION;
    this.data = clone(options.initial ?? null) ?? emptyData();
  }

  async init(): Promise<void> {
    /* состояние уже в памяти */
  }

  async read(): Promise<AppData | null> {
    return clone(this.data);
  }

  async write(data: AppData): Promise<boolean> {
    this.options.onBeforeWrite?.(data);
    // Внутри транзакции запись идёт напрямую: backup снят в её начале,
    // поэтому конкурентная запись откатится вместе с ней, а не потеряется
    // молча, как было, когда write() правил this.data мимо снимка.
    if (this.txDepth > 0) {
      this.data = clone(data);
      return true;
    }
    return this.enqueue(async () => {
      this.data = clone(data);
      return true;
    });
  }

  async clear(): Promise<void> {
    if (this.txDepth > 0) {
      this.data = emptyData();
      this.flags.clear();
      return;
    }
    return this.enqueue(async () => {
      this.data = emptyData();
      this.flags.clear();
    });
  }

  async size(): Promise<number> {
    return new TextEncoder().encode(JSON.stringify(this.data)).byteLength;
  }

  async version(): Promise<number> {
    return this.versionValue;
  }

  async getFlag(key: string): Promise<string | null> {
    return this.flags.get(key) ?? null;
  }

  async setFlag(key: string, value: string): Promise<void> {
    if (value === "") this.flags.delete(key);
    else this.flags.set(key, value);
  }

  /** В памяти «файл» не растёт, поэтому сжатие — ничего не делает. */
  async compact(): Promise<void> {
    // no-op: состояние и так минимально
  }

  async transaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> {
    // Вложенный вызов выполняется сразу, иначе внешняя транзакция ждала бы себя.
    if (this.txDepth > 0) return this.runTransaction(fn);
    return this.enqueue(() => this.runTransaction(fn));
  }

  /** Ставит операцию в очередь — так же, как это делает SQLite-адаптер. */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async runTransaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> {
    if (this.txDepth === 0) this.backup = clone(this.data);
    this.txDepth++;
    try {
      const result = await fn(this);
      this.txDepth--;
      if (this.txDepth === 0) this.backup = null;
      return result;
    } catch (err) {
      this.txDepth--;
      if (this.txDepth === 0 && this.backup) {
        this.data = this.backup;
        this.backup = null;
      }
      throw err;
    }
  }

  /** Счётчик строк по коллекциям — для тестов и диагностики. */
  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const spec of COLLECTION_SPECS) {
      out[spec.collection] = (this.data[spec.collection] ?? []).length;
    }
    return out;
  }

  /** Служебное: эмуляция смены версии схемы в тестах. */
  setVersion(version: number): void {
    this.versionValue = version;
  }
}
