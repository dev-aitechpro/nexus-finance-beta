// src/lib/storage.ts
// Фасад слоя хранения. Приложение по-прежнему вызывает storageService.load/save,
// но внутри это SQLite с миграцией с localStorage (см. src/storage).
import { emptyData } from "./engine";
import type { AppData } from "./types";
import {
  describeStorage,
  getStorage,
  migrationStatus,
  type StorageDescription,
} from "../storage";
import type { StorageAdapter } from "../storage";
import { normalizeAppData, withCompleteShape } from "./normalize";

/* Нормализация и слияние живут в lib/normalize, реэкспорт — для обратной совместимости. */
export { mergeAppData as mergeData, normalizeAppData as normalize } from "./normalize";
export type { StorageDescription };

let active: StorageAdapter | null = null;
let cachedSize = 0;

/** Подмена источника адаптера — только для тестов (в приложении не используется). */
let adapterProvider: (() => Promise<StorageAdapter>) | null = null;

export const setAdapterProvider = (fn: (() => Promise<StorageAdapter>) | null): void => {
  adapterProvider = fn;
};

const useAdapter = async (): Promise<StorageAdapter> => {
  if (adapterProvider) return adapterProvider();
  active = await getStorage();
  return active;
};

/**
 * Ошибка последней загрузки. Приложение обязано отличать «база пуста» (null)
 * от «база не прочиталась»: во втором случае подставлять демо-данные и
 * запускать автосохранение нельзя — это стёрло бы реальные данные.
 */
let lastLoadError: string | null = null;

export const storageService = {
  /** Загрузка документа (автоматически импортирует наследие из localStorage). */
  async load(): Promise<AppData | null> {
    const adapter = await useAdapter();
    try {
      const data = await adapter.read();
      lastLoadError = null;
      return data;
    } catch (e) {
      lastLoadError = (e as Error).message;
      console.error("Ошибка чтения данных из базы:", e);
      throw e;
    } finally {
      // Размер — справочная величина: его не удалось посчитать, это не повод
      // объявлять загрузку неудачной.
      cachedSize = await adapter.size().catch(() => cachedSize);
    }
  },

  /** Текст последней ошибки чтения (null — загрузка прошла). */
  loadError(): string | null {
    return lastLoadError;
  },

  /** Атомарная запись документа в SQLite. */
  async save(data: AppData): Promise<boolean> {
    try {
      const adapter = await useAdapter();
      const ok = await adapter.write(withCompleteShape(data));
      if (ok) cachedSize = await adapter.size().catch(() => cachedSize);
      return ok;
    } catch (e) {
      console.error("Ошибка сохранения данных:", e);
      return false;
    }
  },

  /** Полная очистка. Возвращает промис: вызывающий обязан дождаться результата,
   * иначе отложенное автосохранение вернёт удалённые данные обратно. */
  async clear(): Promise<boolean> {
    try {
      const adapter = await useAdapter();
      await adapter.clear();
      cachedSize = 0;
      return true;
    } catch (e) {
      console.error("Ошибка очистки данных:", e);
      return false;
    }
  },

  /** Сжатие базы (VACUUM): освобождает место после удаления записей. */
  async compact(): Promise<boolean> {
    try {
      const adapter = await useAdapter();
      await adapter.compact();
      cachedSize = await adapter.size().catch(() => cachedSize);
      return true;
    } catch (e) {
      console.error("Ошибка сжатия базы:", e);
      return false;
    }
  },

  bytes(): number {
    return cachedSize;
  },

  mode(): string {
    // До первого вызова адаптер ещё не выбран, и «sqlite» было бы выдумкой.
    return active?.driver ?? "не определён";
  },

  /** Сводка для UI (драйвер, путь, размер, режим журнала, статус миграции). */
  description(): Promise<StorageDescription> {
    return describeStorage();
  },
};

export function serializeExport(data: AppData): string {
  return JSON.stringify(
    { app: "nexus-finance", version: 1, exportedAt: new Date().toISOString(), data: withCompleteShape(data) },
    null,
    2,
  );
}

export function parseImport(text: string): AppData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Файл не является корректным JSON");
  }
  const wrapped = parsed as { data?: unknown };
  const candidate = wrapped && typeof wrapped === "object" && "data" in wrapped && wrapped.data ? wrapped.data : parsed;
  const normalized = normalizeAppData(candidate);
  if (!normalized) throw new Error("Структура файла не похожа на бэкап NEXUS Finance");
  return withCompleteShape(normalized);
}

export const emptyDocument = (): AppData => emptyData();

/* Резервные копии в облаке удалены: Яндекс Диск требовал OAuth-токен,
   хранил его в localStorage и не работал в desktop-сборке (redirect_uri
   получался "null" под протоколом file://). Остались локальный экспорт и
   импорт JSON и файл SQLite в папке приложения — они работают офлайн
   и без аккаунтов. */


export interface StorageInfo {
  mode: string;
  path: string;
  bytes: number;
  status: string;
}

/** Синхронный снимок (для мест, где await недоступен). */
export const storageInfo = (): StorageInfo => {
  const isDesktop = typeof window !== "undefined" && window.electronAPI !== undefined;
  return {
    mode: storageService.mode(),
    path: isDesktop ? "app://nexus-data.sqlite" : "indexeddb://nexus-finance/db.sqlite",
    bytes: storageService.bytes(),
    status: isDesktop
      ? "Данные в файле SQLite на ПК"
      : migrationStatus() === "imported"
        ? "Данные перенесены из localStorage в SQLite"
        : "Данные в SQLite (IndexedDB)",
  };
};
