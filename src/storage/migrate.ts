// src/storage/migrate.ts
// Перенос данных из localStorage в SQLite (ТЗ п. 3.2).
// Гарантии: импорт идёт в одной транзакции, при ошибке — полный откат,
// исходный ключ НЕ удаляется (остаётся для отката на LEGACY_KEEP_DAYS дней,
// после чего чистится функцией purgeLegacySource).
import { STORAGE_KEY } from "../lib/constants";
import { isEmptyAppData, normalizeAppData, withCompleteShape } from "../lib/normalize";
import type { StorageAdapter } from "./types";

/** Флаг завершения миграции (лежит в таблице meta, не в localStorage). */
export const LEGACY_MIGRATION_FLAG = "migration.legacy.v1";

/** Когда был перенос — по этой метке считается срок отката. */
export const LEGACY_MIGRATED_AT_FLAG = "migration.legacy.v1.migratedAt";

/** Сколько дней храним исходные данные для отката (ТЗ п. 3.2). */
export const LEGACY_KEEP_DAYS = 30;

/** Ключи, из которых читаем наследие: текущий плюс исторические. */
export const LEGACY_KEYS: readonly string[] = [STORAGE_KEY, "nexus.data", "promtova-state"];

export type MigrationStatus = "imported" | "already-done" | "no-source" | "invalid-source" | "failed";

export interface MigrationReport {
  status: MigrationStatus;
  sourceKey: string | null;
  collections: Record<string, number>;
  total: number;
  /** Исходные данные сохранены для отката. */
  sourcePreserved: boolean;
  error?: string;
  durationMs: number;
}

export interface LegacySourceOptions {
  keys?: readonly string[];
  getItem?: (key: string) => string | null;
  now?: () => number;
}

const defaultGetItem = (key: string): string | null => {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
};

const defaultRemoveItem = (key: string): void => {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(key);
  } catch {
    /* приватный режим — удалить нельзя */
  }
};

const countByCollection = (data: ReturnType<typeof normalizeAppData>): Record<string, number> => {
  const out: Record<string, number> = {};
  if (!data) return out;
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) out[key] = value.length;
  }
  return out;
};

/** Читает первый непустой legacy-ключ. */
export function readLegacySource(options: LegacySourceOptions = {}): { key: string; raw: string } | null {
  const getItem = options.getItem ?? defaultGetItem;
  for (const key of options.keys ?? LEGACY_KEYS) {
    const raw = getItem(key);
    if (raw && raw.length > 2) return { key, raw };
  }
  return null;
}

interface LegacyCandidate {
  key: string;
  raw: string;
  data: ReturnType<typeof normalizeAppData>;
  error?: string;
}

/**
 * Перебирает все legacy-ключи и берёт первый, который разобрался.
 * Раньше битый первый ключ обрывал миграцию целиком, хотя валидные данные
 * могли лежать в следующем (LEGACY_KEYS существует именно для этого).
 */
function collectCandidates(options: LegacySourceOptions): LegacyCandidate[] {
  const getItem = options.getItem ?? defaultGetItem;
  const out: LegacyCandidate[] = [];
  for (const key of options.keys ?? LEGACY_KEYS) {
    const raw = getItem(key);
    if (!raw || raw.length <= 2) continue;
    try {
      const data = normalizeAppData(JSON.parse(raw));
      if (data) out.push({ key, raw, data });
      else out.push({ key, raw, data: null, error: "Структура данных не соответствует схеме NEXUS Finance" });
    } catch (err) {
      out.push({ key, raw, data: null, error: `Не удалось разобрать JSON: ${(err as Error).message}` });
    }
  }
  return out;
}

export interface LegacyBackupStatus {
  key: string;
  migratedAt: string;
  expiresAt: string;
  daysLeft: number;
  expired: boolean;
}

/**
 * Состояние резервной копии в localStorage для отката.
 * ТЗ п. 3.2: исходные данные хранятся 30 дней, потом удаляются.
 */
export async function legacyBackupStatus(
  adapter: StorageAdapter,
  options: LegacySourceOptions = {},
): Promise<LegacyBackupStatus | null> {
  const migratedAt = await adapter.getFlag(LEGACY_MIGRATED_AT_FLAG);
  if (!migratedAt) return null;
  const source = readLegacySource(options);
  if (!source) return null;
  const now = options.now?.() ?? Date.now();
  const expires = Date.parse(migratedAt) + LEGACY_KEEP_DAYS * 86_400_000;
  const daysLeft = Math.ceil((expires - now) / 86_400_000);
  return {
    key: source.key,
    migratedAt,
    expiresAt: new Date(expires).toISOString(),
    daysLeft,
    expired: daysLeft <= 0,
  };
}

/**
 * Удаляет исходные данные, когда срок отката истёк. Вызывается при старте;
 * повторный вызов безопасен.
 */
export async function purgeLegacySource(
  adapter: StorageAdapter,
  options: LegacySourceOptions & { removeItem?: (key: string) => void } = {},
): Promise<{ purged: boolean; key: string | null }> {
  const status = await legacyBackupStatus(adapter, options);
  if (!status || !status.expired) return { purged: false, key: status?.key ?? null };
  // Удаляем, только если перенос действительно завершён: флаг миграции стоит.
  const done = await adapter.getFlag(LEGACY_MIGRATION_FLAG);
  if (!done) return { purged: false, key: status.key };
  const remove = options.removeItem ?? defaultRemoveItem;
  remove(status.key);
  await adapter.setFlag(LEGACY_MIGRATED_AT_FLAG, "").catch(() => undefined);
  console.info(`[storage] срок отката истёк, ключ ${status.key} удалён`);
  return { purged: true, key: status.key };
}

/**
 * Импортирует наследие в адаптер. Повторный вызов безопасен:
 * при уже установленном флаге или непустой базе ничего не делает.
 */
export async function migrateLegacyData(
  adapter: StorageAdapter,
  options: LegacySourceOptions = {},
): Promise<MigrationReport> {
  const t0 = options.now?.() ?? Date.now();
  const done = (report: Omit<MigrationReport, "durationMs">): MigrationReport => ({
    ...report,
    durationMs: Math.max(0, (options.now?.() ?? Date.now()) - t0),
  });

  await adapter.init();

  const candidates = collectCandidates(options);
  if (candidates.length === 0) {
    return done({ status: "no-source", sourceKey: null, collections: {}, total: 0, sourcePreserved: true });
  }

  const flag = await adapter.getFlag(LEGACY_MIGRATION_FLAG);
  if (flag) {
    return done({
      status: "already-done",
      sourceKey: candidates[0].key,
      collections: {},
      total: 0,
      sourcePreserved: true,
    });
  }

  const source = candidates.find((c) => c.data !== null);
  if (!source?.data) {
    // Ни один ключ не разобрался — сообщаем причину по первому кандидату.
    return done({
      status: "invalid-source",
      sourceKey: candidates[0].key,
      collections: {},
      total: 0,
      sourcePreserved: true,
      error: candidates.map((c) => `${c.key}: ${c.error}`).join("; "),
    });
  }

  const existing = await adapter.read();
  if (!isEmptyAppData(existing)) {
    // В базе уже есть данные (например, обновление поверх установленной версии) —
    // не перетираем их, только фиксируем факт, что наследие разобрано.
    const stamp = new Date(options.now?.() ?? Date.now()).toISOString();
    await adapter.transaction(async (tx) => {
      await tx.setFlag(LEGACY_MIGRATION_FLAG, stamp);
      await tx.setFlag(LEGACY_MIGRATED_AT_FLAG, stamp);
    });
    const collections = countByCollection(existing);
    return done({
      status: "already-done",
      sourceKey: source.key,
      collections,
      total: Object.values(collections).reduce((sum, n) => sum + n, 0),
      sourcePreserved: true,
    });
  }

  const data = withCompleteShape(source.data);
  const stamp = new Date(options.now?.() ?? Date.now()).toISOString();
  try {
    await adapter.transaction(async (tx) => {
      await tx.write(data);
      await tx.setFlag(LEGACY_MIGRATION_FLAG, stamp);
      // Метка переноса нужна для 30-дневного срока отката.
      await tx.setFlag(LEGACY_MIGRATED_AT_FLAG, stamp);
    });
  } catch (err) {
    console.error("[storage] миграция не удалась, откат выполнен:", err);
    return done({
      status: "failed",
      sourceKey: source.key,
      collections: {},
      total: 0,
      sourcePreserved: true,
      error: (err as Error).message,
    });
  }

  return done({
    status: "imported",
    sourceKey: source.key,
    collections: countByCollection(data),
    total: 1,
    sourcePreserved: true,
  });
}
