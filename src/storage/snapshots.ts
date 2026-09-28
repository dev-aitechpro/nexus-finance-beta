// src/storage/snapshots.ts
// Куда сохранять снапшот БД. Приоритет: файл в userData (Electron) →
// IndexedDB (браузер/WebView) → localStorage (запасной вариант) → память.
//
// Важные гарантии, которые проверяются тестами:
//  * запись считается успешной только после КОММИТА транзакции IndexedDB —
//    иначе откат по квоте прошёл бы как успех, и данные пропали бы;
//  * ошибка записи пробрасывается наверх, чтобы адаптер пометил хранилище
//    временным, а не сообщил пользователю «сохранено»;
//  * если IndexedDB молчит (или отдаёт пусто), спрашивается резерв — иначе
//    свежая копия из localStorage незаметно проигрывала бы старой из IDB.
import type { SnapshotKind, SnapshotStore } from "./types";

const IDB_NAME = "nexus-finance";
const IDB_STORE = "snapshots";
const IDB_KEY = "db.sqlite";
const LS_KEY = "nexus.sqlite.snapshot";

/** Сколько ждём открытия IndexedDB, прежде чем уйти в резерв. */
const IDB_OPEN_TIMEOUT_MS = 3000;

const hasIndexedDb = (): boolean => typeof indexedDB !== "undefined";

const hasLocalStorage = (): boolean => {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false;
  }
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

const base64ToBytes = (base64: string): Uint8Array => {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** instanceof Uint8Array не срабатывает для значений из другого realm (iframe). */
const asBytes = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
};

const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });

/** Снапшот только в памяти — тесты и режим без постоянного хранилища. */
export class MemorySnapshotStore implements SnapshotStore {
  readonly kind: SnapshotKind = "memory";
  private bytes: Uint8Array | null = null;

  async load(): Promise<Uint8Array | null> {
    return this.bytes;
  }

  async save(bytes: Uint8Array): Promise<void> {
    this.bytes = bytes.slice();
  }

  async clear(): Promise<void> {
    this.bytes = null;
  }
}

/** Основной вариант для браузера и WebView-контейнеров. */
export class IndexedDbSnapshotStore implements SnapshotStore {
  readonly kind: SnapshotKind = "indexeddb";
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly fallback?: SnapshotStore) {}

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    const promise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Другая вкладка обновила схему — освобождаем соединение,
        // иначе у неё будет висеть блокировка удаления базы.
        db.onversionchange = () => {
          db.close();
          this.dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new Error("IndexedDB недоступна"));
      req.onblocked = () => reject(new Error("IndexedDB: открытие заблокировано другой вкладкой"));
    });
    // Отказ не должен «прибивать» IndexedDB до конца сессии: следующая
    // попытка открытия должна состояться.
    this.dbPromise = promise.catch((err) => {
      this.dbPromise = null;
      throw err;
    });
    return this.dbPromise;
  }

  /**
   * Запись завершается только на oncomplete транзакции: успешный запрос
   * бывает и при последующем откате (квота, прерывание), и тогда данные
   * на самом деле не записаны.
   */
  private async put(bytes: Uint8Array): Promise<void> {
    const db = await withTimeout(this.open(), IDB_OPEN_TIMEOUT_MS, "IndexedDB: таймаут открытия");
    await new Promise<void>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(IDB_STORE, "readwrite");
      } catch (err) {
        reject(err as Error);
        return;
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB: транзакция не выполнена"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB: транзакция прервана"));
      try {
        tx.objectStore(IDB_STORE).put(bytes, IDB_KEY);
      } catch (err) {
        reject(err as Error);
      }
    });
  }

  private async get(): Promise<Uint8Array | null> {
    const db = await withTimeout(this.open(), IDB_OPEN_TIMEOUT_MS, "IndexedDB: таймаут открытия");
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB: ошибка чтения"));
    });
    return asBytes(value);
  }

  private async del(): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB: ошибка удаления"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB: удаление прервано"));
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
    });
  }

  async load(): Promise<Uint8Array | null> {
    try {
      const value = await this.get();
      // Пустой IDB — не повод забыть про резерв: там может лежать более
      // свежая копия, если предыдущая запись в IDB не прошла.
      if (value && value.byteLength > 0) return value;
    } catch (err) {
      console.warn("[storage] IndexedDB чтение не удалось:", err);
    }
    return (await this.fallback?.load()) ?? null;
  }

  async save(bytes: Uint8Array): Promise<void> {
    try {
      await this.put(bytes);
      // Копия в IDB актуальна — резерв можно убрать, иначе он перебьёт
      // данные при следующем чтении, когда IDB временно опустеет.
      await this.fallback?.clear().catch(() => undefined);
    } catch (err) {
      console.warn("[storage] IndexedDB запись не удалась, пробуем резерв:", err);
      if (!this.fallback) throw err;
      try {
        await this.fallback.save(bytes);
      } catch (fallbackErr) {
        // Ни IDB, ни резерв не сработали: сообщаем наверх, чтобы хранилище
        // было помечено временным, а не «успешно сохранённым».
        throw new Error(
          `не удалось сохранить базу: ${(err as Error).message}; резерв: ${(fallbackErr as Error).message}`,
        );
      }
      // В IDB осталась старая копия — она перебьёт резерв при чтении.
      await this.del().catch(() => undefined);
    }
  }

  async clear(): Promise<void> {
    await this.del().catch(() => undefined);
    await this.fallback?.clear().catch(() => undefined);
  }
}

/** Запасной вариант: base64 в localStorage (меньше ёмкость, но переживает перезапуск). */
export class LocalStorageSnapshotStore implements SnapshotStore {
  readonly kind: SnapshotKind = "localstorage";

  constructor(private readonly key: string = LS_KEY) {}

  async load(): Promise<Uint8Array | null> {
    try {
      const raw = localStorage.getItem(this.key);
      return raw ? base64ToBytes(raw) : null;
    } catch (err) {
      // Битый base64 не должен молча выглядеть как «базы нет»: сохраняем
      // испорченное значение отдельно и сообщаем.
      console.error("[storage] снапшот в localStorage повреждён:", err);
      try {
        const raw = localStorage.getItem(this.key);
        if (raw) localStorage.setItem(`${this.key}.corrupt`, raw);
      } catch {
        /* ничего не сделать */
      }
      return null;
    }
  }

  async save(bytes: Uint8Array): Promise<void> {
    localStorage.setItem(this.key, bytesToBase64(bytes));
  }

  async clear(): Promise<void> {
    try {
      localStorage.removeItem(this.key);
    } catch {
      /* игнорируем */
    }
  }
}

/** Windows/Electron: БД лежит файлом в userData и пишется атомарно. */
export class ElectronSnapshotStore implements SnapshotStore {
  readonly kind: SnapshotKind = "file";

  async load(): Promise<Uint8Array | null> {
    try {
      const base64 = await window.electronAPI?.loadDb?.();
      return base64 ? base64ToBytes(base64) : null;
    } catch (err) {
      // Файл есть, но не читается — это не «первый запуск»: сообщаем, чтобы
      // приложение не перезаписало его пустой базой.
      throw new Error(`не удалось прочитать файл базы: ${(err as Error).message}`);
    }
  }

  async save(bytes: Uint8Array): Promise<void> {
    const ok = await window.electronAPI?.saveDb?.(bytesToBase64(bytes));
    // main-процесс возвращает false при EPERM/ENOSPC и т.п. Молчать об этом
    // нельзя: пользователь увидит «сохранено», а данных на диске не будет.
    if (ok === false) throw new Error("main-процесс не смог записать файл базы");
  }

  async clear(): Promise<void> {
    await window.electronAPI?.clearDb?.();
  }
}

/** Выбор хранилища снапшота под текущую платформу. */
export function createSnapshotStore(): SnapshotStore {
  if (typeof window !== "undefined" && window.electronAPI?.loadDb) return new ElectronSnapshotStore();
  if (hasIndexedDb()) {
    return new IndexedDbSnapshotStore(hasLocalStorage() ? new LocalStorageSnapshotStore() : undefined);
  }
  if (hasLocalStorage()) return new LocalStorageSnapshotStore();
  return new MemorySnapshotStore();
}
