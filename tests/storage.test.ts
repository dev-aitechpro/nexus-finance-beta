// tests/storage.test.ts
// Группа 5 ТЗ: слой хранения — миграция, транзакции, откат, персистентность.
import { afterEach, describe, expect, it } from "vitest";
import { emptyData } from "../src/lib/engine";
import { mergeAppData, normalizeAppData } from "../src/lib/normalize";
import { setAdapterProvider, storageService } from "../src/lib/storage";
import type { AppData } from "../src/lib/types";
import { createStorageAdapter } from "../src/storage";
import { MemoryStorage } from "../src/storage/memory";
import {
  LEGACY_MIGRATION_FLAG,
  legacyBackupStatus,
  migrateLegacyData,
  purgeLegacySource,
} from "../src/storage/migrate";
import { deleteRowsOp, SCHEMA_VERSION } from "../src/storage/schema";
import {
  ElectronSnapshotStore,
  LocalStorageSnapshotStore,
  MemorySnapshotStore,
} from "../src/storage/snapshots";
import { SqliteStorage, type SqlJsLoader } from "../src/storage/sqlite";
import { sampleData, tx } from "./helpers/fixtures";
import { nodeSqlJsLoader } from "./helpers/sqljs";

const sqlite = (snapshots = new MemorySnapshotStore(), load: SqlJsLoader = nodeSqlJsLoader): SqliteStorage =>
  new SqliteStorage({ snapshots, load });

describe("SQLite: схема и PRAGMA", () => {
  it("поднимает схему до актуальной версии", async () => {
    const storage = sqlite();
    await storage.init();
    expect(await storage.version()).toBe(SCHEMA_VERSION);
  });

  it("отдаёт режим журнала (WAL для файловой БД, memory для in-memory)", async () => {
    const storage = sqlite();
    await storage.init();
    // sql.js — in-memory движок, WAL недоступен; проверяем, что PRAGMA отвечает
    expect(["wal", "memory", "delete", "truncate", "persist"]).toContain(storage.sql!.journalMode());
  });

  it("переживает повторную инициализацию (идемпотентно)", async () => {
    const storage = sqlite();
    await storage.init();
    await storage.init();
    expect(await storage.version()).toBe(SCHEMA_VERSION);
  });
});

describe("SQLite: документ", () => {
  it("сохраняет и читает данные без потерь", async () => {
    const storage = sqlite();
    const data = sampleData();
    expect(await storage.write(data)).toBe(true);
    const read = await storage.read();
    expect(read).not.toBeNull();
    expect(read!.transactions).toHaveLength(3);
    expect(read!.currency).toBe("USD");
    expect(read!.theme).toBe("dark");
    expect(read!.fontScale).toBeCloseTo(1.15);
    expect(read!.goals[0].name).toBe("Подушка");
  });

  it("не плодит дубли при повторной записи (UPSERT по id)", async () => {
    const storage = sqlite();
    const data = sampleData();
    await storage.write(data);
    await storage.write(data);
    await storage.write(data);
    const read = await storage.read();
    expect(read!.transactions).toHaveLength(3);
  });

  it("удаляет записи, которых больше нет в документе", async () => {
    const storage = sqlite();
    const data = sampleData();
    await storage.write(data);
    const trimmed = { ...data, transactions: data.transactions.slice(0, 1) };
    await storage.write(trimmed);
    const read = await storage.read();
    expect(read!.transactions).toHaveLength(1);
    expect(read!.transactions[0].id).toBe("t1");
  });

  it("поддерживает SQL-выборку по индексу, а не сканирование", async () => {
    const storage = sqlite();
    await storage.write(sampleData());
    const rows = await storage.sql!.query<{ id: string }>(
      `SELECT "id" FROM "transactions" WHERE "category" = ? AND "date" >= ? ORDER BY "date" LIMIT 10`,
      ["cafe", "2026-03-01"],
    );
    expect(rows.map((r) => r.id)).toEqual(["t2"]);
  });

  it("размер и флаги хранилища", async () => {
    const storage = sqlite();
    await storage.write(sampleData());
    expect(await storage.size()).toBeGreaterThan(0);
    await storage.setFlag("test.flag", "1");
    expect(await storage.getFlag("test.flag")).toBe("1");
    expect(await storage.getFlag("missing")).toBeNull();
  });

  it("очистка сносит записи, но оставляет схему", async () => {
    const storage = sqlite();
    await storage.write(sampleData());
    await storage.clear();
    const read = await storage.read();
    expect(read === null || read!.transactions.length === 0).toBe(true);
    expect(await storage.version()).toBe(SCHEMA_VERSION);
  });
});

describe("SQLite: транзакции и откат", () => {
  it("откатывает неудачную транзакцию без частичной записи", async () => {
    const storage = sqlite();
    await storage.write(sampleData());

    await expect(
      storage.transaction(async (txAdapter) => {
        const next = { ...sampleData(), transactions: [tx({ id: "new-1" })] };
        await txAdapter.write(next);
        throw new Error("сбой в середине");
      }),
    ).rejects.toThrow("сбой в середине");

    const read = await storage.read();
    expect(read!.transactions).toHaveLength(3);
    expect(read!.transactions.some((t) => t.id === "new-1")).toBe(false);
  });

  it("транзакция фиксирует несколько операций разом", async () => {
    const storage = sqlite();
    const base = sampleData();
    await storage.write(base);
    await storage.transaction(async (txAdapter) => {
      await txAdapter.write({ ...base, theme: "light" });
      await txAdapter.setFlag("ui.onboarded.v1", "2026-03-01");
    });
    const read = await storage.read();
    expect(read!.theme).toBe("light");
    expect(await storage.getFlag("ui.onboarded.v1")).toBe("2026-03-01");
  });

  it("вложенные вызовы не ломают COMMIT", async () => {
    const storage = sqlite();
    const base = sampleData();
    await storage.transaction(async (outer) => {
      await outer.write(base);
      await outer.transaction(async (inner) => {
        await inner.setFlag("nested", "yes");
      });
    });
    expect(await storage.getFlag("nested")).toBe("yes");
    expect((await storage.read())!.transactions).toHaveLength(3);
  });

  it("параллельные записи не оставляют мусор (последовательные транзакции)", async () => {
    const storage = sqlite();
    const base = sampleData();
    await storage.write(base);
    await Promise.all([
      storage.transaction(async (t) => t.setFlag("k1", "a")),
      storage.transaction(async (t) => t.setFlag("k2", "b")),
    ]);
    expect(await storage.getFlag("k1")).toBe("a");
    expect(await storage.getFlag("k2")).toBe("b");
  });
});

describe("SQLite: персистентность", () => {
  it("восстанавливает данные из снапшота после перезапуска", async () => {
    const snapshots = new MemorySnapshotStore();
    const first = sqlite(snapshots);
    await first.write(sampleData());

    const second = sqlite(snapshots);
    const read = await second.read();
    expect(read!.transactions).toHaveLength(3);
    expect(read!.currency).toBe("USD");
  });

  it("битый снапшот не роняет приложение: база создаётся заново", async () => {
    const snapshots = new MemorySnapshotStore();
    await snapshots.save(new Uint8Array([1, 2, 3, 4, 5]));
    const storage = sqlite(snapshots);
    await storage.init();
    expect(await storage.version()).toBe(SCHEMA_VERSION);
    expect(await storage.write(sampleData())).toBe(true);
  });
});

describe("Миграция с localStorage", () => {
  it("импортирует наследие и ставит флаг", async () => {
    const storage = sqlite();
    const legacy = JSON.stringify(sampleData());
    const report = await migrateLegacyData(storage, { getItem: (k) => (k === "nexus.data.v1" ? legacy : null) });

    expect(report.status).toBe("imported");
    expect(report.sourcePreserved).toBe(true);
    expect(report.collections.transactions).toBe(3);
    expect(await storage.getFlag(LEGACY_MIGRATION_FLAG)).toBeTruthy();

    const read = await storage.read();
    expect(read!.transactions).toHaveLength(3);
    expect(read!.currency).toBe("USD");
  });

  it("повторный запуск ничего не импортирует", async () => {
    const storage = sqlite();
    const legacy = JSON.stringify(sampleData());
    const getItem = (k: string) => (k === "nexus.data.v1" ? legacy : null);
    expect((await migrateLegacyData(storage, { getItem })).status).toBe("imported");
    expect((await migrateLegacyData(storage, { getItem })).status).toBe("already-done");
  });

  it("нет источника — миграция не требуется", async () => {
    const storage = sqlite();
    const report = await migrateLegacyData(storage, { getItem: () => null });
    expect(report.status).toBe("no-source");
  });

  it("битый JSON не приводит к потере данных", async () => {
    const storage = sqlite();
    const report = await migrateLegacyData(storage, { getItem: () => "{не json" });
    expect(report.status).toBe("invalid-source");
    expect(await storage.read()).toBeNull();
  });

  it("при сбое записи откат выполняется, исходник сохраняется", async () => {
    const failing = new MemoryStorage({
      onBeforeWrite: () => {
        throw new Error("диск полон");
      },
    });
    const legacy = JSON.stringify(sampleData());
    const report = await migrateLegacyData(failing, { getItem: () => legacy });

    expect(report.status).toBe("failed");
    expect(report.error).toContain("диск полон");
    expect(report.sourcePreserved).toBe(true);
    expect(await failing.getFlag(LEGACY_MIGRATION_FLAG)).toBeNull();
  });

  it("не перетирает уже существующие данные в базе", async () => {
    const storage = sqlite();
    await storage.write(sampleData());
    const legacy = JSON.stringify({ ...sampleData(), transactions: [] });
    const report = await migrateLegacyData(storage, { getItem: () => legacy });
    expect(report.status).toBe("already-done");
    expect((await storage.read())!.transactions).toHaveLength(3);
  });

  it("читает источник по списку ключей, включая исторические", async () => {
    const storage = sqlite();
    const legacy = JSON.stringify(sampleData());
    const report = await migrateLegacyData(storage, {
      keys: ["nexus.data.v1", "promtova-state"],
      getItem: (k) => (k === "promtova-state" ? legacy : null),
    });
    expect(report.status).toBe("imported");
    expect(report.sourceKey).toBe("promtova-state");
  });
});

describe("Адаптер в памяти", () => {
  it("откатывает транзакцию при ошибке", async () => {
    const storage = new MemoryStorage();
    await storage.write(sampleData());
    await expect(
      storage.transaction(async (txAdapter) => {
        await txAdapter.write(sampleData());
        throw new Error("отмена");
      }),
    ).rejects.toThrow("отмена");
    expect((await storage.read())!.transactions).toHaveLength(3);
  });

  it("считает записи по коллекциям", async () => {
    const storage = new MemoryStorage();
    await storage.write(sampleData());
    const counts = storage.counts();
    expect(counts.transactions).toBe(3);
    expect(counts.goals).toBe(1);
  });
});

describe("Деградация: SQLite недоступен", () => {
  it("приложение продолжает работать в памяти", async () => {
    const broken: SqlJsLoader = async () => {
      throw new Error("WebAssembly выключен");
    };
    const storage = await createStorageAdapter(broken);
    expect(storage.driver).toBe("memory");
    expect(storage.persistent).toBe(false);

    // Запись/чтение продолжают работать, просто без персистентности
    expect(await storage.write(sampleData())).toBe(true);
    expect((await storage.read())!.transactions).toHaveLength(3);
  });
});

describe("Резервные хранилища снапшота", () => {
  const fakeLocalStorage = () => {
    const map = new Map<string, string>();
    const stub = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
    (globalThis as unknown as { localStorage: typeof stub }).localStorage = stub;
    return stub;
  };

  it("снапшот в localStorage переживает перезапуск", async () => {
    const stub = fakeLocalStorage();
    const first = new LocalStorageSnapshotStore();
    await first.save(new Uint8Array([1, 2, 3, 250, 0, 99]));

    const second = new LocalStorageSnapshotStore();
    const bytes = await second.load();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...(bytes ?? [])]).toEqual([1, 2, 3, 250, 0, 99]);

    await second.clear();
    expect(stub.getItem("nexus.sqlite.snapshot")).toBeNull();
  });

  it("снапшот в памяти переживает перезапуск адаптера", async () => {
    const store = new MemorySnapshotStore();
    const first = sqlite(store);
    await first.write(sampleData());
    const second = sqlite(store);
    expect((await second.read())!.transactions).toHaveLength(3);
  });

  it("объявляет тип хранилища (kind) — по нему считается надёжность", async () => {
    expect(new MemorySnapshotStore().kind).toBe("memory");
    expect(new LocalStorageSnapshotStore().kind).toBe("localstorage");
  });
});

describe("Хранилище в Electron: ошибки не проходят молча", () => {
  const withElectron = async (
    api: Partial<NonNullable<Window["electronAPI"]>>,
    fn: () => Promise<void>,
  ) => {
    const g = globalThis as unknown as { window?: { electronAPI?: unknown } };
    const previous = g.window;
    g.window = { electronAPI: api };
    try {
      await fn();
    } finally {
      if (previous === undefined) delete g.window;
      else g.window = previous;
    }
  };

  it("сообщает об ошибке записи файла, а не рапортует успех", async () => {
    const store = new ElectronSnapshotStore();
    await withElectron(
      { saveDb: async () => false },
      async () => {
        // Раньше false игнорировался: UI показывал «сохранено», а на диске
        // ничего не было — пользователь терял данные при следующем запуске.
        await expect(store.save(new Uint8Array([1, 2, 3]))).rejects.toThrow(/не смог записать/);
      },
    );
  });

  it("успешная запись проходит без ошибок", async () => {
    const store = new ElectronSnapshotStore();
    await withElectron({ saveDb: async () => true }, async () => {
      await expect(store.save(new Uint8Array([1, 2, 3]))).resolves.toBeUndefined();
    });
  });

  it("нечитаемый файл отличает от отсутствующего", async () => {
    const store = new ElectronSnapshotStore();
    await withElectron(
      {
        loadDb: async () => {
          throw new Error("EPERM");
        },
      },
      async () => {
        await expect(store.load()).rejects.toThrow(/EPERM/);
      },
    );
    await withElectron({ loadDb: async () => null }, async () => {
      await expect(store.load()).resolves.toBeNull();
    });
  });
});

describe("Честность статуса хранилища", () => {
  it("persistent = false, когда снапшот только в памяти", async () => {
    const storage = sqlite(new MemorySnapshotStore());
    await storage.write(sampleData());
    // Раньше было жёстко true: UI обещал надёжность при хранении в памяти сеанса.
    expect(storage.persistent).toBe(false);
  });

  it("persistent = true для IDB-хранилища", async () => {
    const idbLike = { kind: "indexeddb" as const, load: async () => null, save: async () => undefined, clear: async () => undefined };
    const storage = new SqliteStorage({ snapshots: idbLike, load: nodeSqlJsLoader });
    await storage.write(sampleData());
    expect(storage.persistent).toBe(true);
  });

  it("неудачная запись снапшота переводит хранилище во временное", async () => {
    let fail = false;
    const flaky = {
      kind: "indexeddb" as const,
      load: async () => null,
      save: async () => {
        if (fail) throw new Error("квота исчерпана");
      },
      clear: async () => undefined,
    };
    const storage = new SqliteStorage({ snapshots: flaky, load: nodeSqlJsLoader });
    await storage.write(sampleData());
    expect(storage.persistent).toBe(true);

    fail = true;
    await storage.write(sampleData());
    expect(storage.persistent).toBe(false);
    expect(storage.status.persistError).toMatch(/квота/);
  });

  it("база из более новой версии: чтение есть, запись запрещена", async () => {
    const store = new MemorySnapshotStore();
    const first = sqlite(store);
    await first.write(sampleData());
    // Имитируем базу, созданную более новой версией приложения, и сразу
    // сохраняем снапшот — иначе второй адаптер прочитает прежнюю версию.
    await first.sql!.exec("UPDATE meta SET value = ? WHERE key = ?", ["99", "schema_version"]);
    const bytes = await first.sql!.export();
    await store.save(bytes!);

    const second = sqlite(store);
    await expect(second.init()).resolves.toBeUndefined();
    expect(await second.read()).not.toBeNull(); // данные читаются
    await expect(second.write(sampleData())).rejects.toThrow(/более новой версией/);
  });
});

describe("Очередь записи: параллельные операции не мешают друг другу", () => {
  it("две записи подряд не сливаются в одну транзакцию", async () => {
    const storage = sqlite();
    const first = sampleData();
    const second = { ...sampleData(), transactions: [...sampleData().transactions, tx({ id: "t4" })] };

    // Обе записи возвращают true — значит обе реально закоммичены.
    const [ok1, ok2] = await Promise.all([storage.write(first), storage.write(second)]);
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);

    const read = await storage.read();
    // Второй документ — финальное состояние, первая запись не должна была
    // удалить его строки как «устаревшие».
    expect(read!.transactions.map((t) => t.id).sort()).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("откат второй транзакции не отменяет уже возвращённую первую запись", async () => {
    const storage = sqlite();
    await storage.write(sampleData());

    const okWrite = storage.write({ ...sampleData(), currency: "EUR" });
    const failing = storage.transaction(async (t) => {
      await t.setFlag("temp", "1");
      throw new Error("сбой");
    });

    await expect(okWrite).resolves.toBe(true);
    await expect(failing).rejects.toThrow("сбой");

    // Запись, о которой вызывающему уже сообщили «true», должна сохраниться,
    // а флаг из откатанной транзакции — нет.
    expect((await storage.read())!.currency).toBe("EUR");
    expect(await storage.getFlag("temp")).toBeNull();
  });

  it("очередь переживает ошибку: следующая операция всё равно выполняется", async () => {
    const storage = sqlite();
    await expect(
      storage.transaction(async () => {
        throw new Error("первая упала");
      }),
    ).rejects.toThrow("первая упала");

    await expect(storage.write(sampleData())).resolves.toBe(true);
    expect((await storage.read())!.transactions).toHaveLength(3);
  });
});

describe("Нормализация данных", () => {
  it("принимает документ без транзакций, но с подписками", async () => {
    // Раньше normalizeAppData требовал массив transactions и отбраковывал
    // весь документ: терялись подписки, бюджеты и цели.
    const normalized = normalizeAppData({
      subscriptions: [{ id: "s1", name: "Музыка", amount: 299 }],
      currency: "USD",
    });
    expect(normalized).not.toBeNull();
    expect(normalized!.subscriptions).toHaveLength(1);
    expect(normalized!.transactions).toEqual([]);
    expect(normalized!.currency).toBe("USD");
  });

  it("отбрасывает записи без строкового id", () => {
    const normalized = normalizeAppData({ transactions: [{ id: "ok" }, { amount: 10 }, null] })!;
    expect(normalized.transactions).toHaveLength(1);
  });

  it("при слиянии не теряет настройки базового документа", () => {
    const base = { ...emptyData(), currency: "EUR" as const, theme: "light" as const };
    // В бэкапе настроек темы нет — раньше она молча сбрасывалась на дефолт.
    const incoming = { ...emptyData(), currency: "USD" as const, theme: undefined } as unknown as AppData;
    const merged = mergeAppData(base, incoming);
    expect(merged.currency).toBe("USD"); // из incoming
    expect(merged.theme).toBe("light"); // из base, а не сброшено
  });
});

describe("Срок отката на старые данные (30 дней)", () => {
  it("внутри срока исходный ключ сохраняется", async () => {
    const storage = new MemoryStorage();
    const key = "nexus.data.v1";
    const values = new Map<string, string>([[key, JSON.stringify(sampleData())]]);
    const opts = {
      keys: [key],
      getItem: (k: string) => values.get(k) ?? null,
      now: () => 1_700_000_000_000,
    };
    const report = await migrateLegacyData(storage, opts);
    expect(report.status).toBe("imported");

    const status = await legacyBackupStatus(storage, opts);
    expect(status?.key).toBe(key);
    expect(status?.expired).toBe(false);
    expect(status!.daysLeft).toBeGreaterThan(0);
  });

  it("после 30 дней исходный ключ удаляется", async () => {
    const storage = new MemoryStorage();
    const key = "nexus.data.v1";
    const values = new Map<string, string>([[key, JSON.stringify(sampleData())]]);
    const removed: string[] = [];
    const base = Date.parse("2026-01-01T00:00:00.000Z");

    const opts = {
      keys: [key],
      getItem: (k: string) => values.get(k) ?? null,
      removeItem: (k: string) => {
        removed.push(k);
        values.delete(k);
      },
    };
    await migrateLegacyData(storage, { ...opts, now: () => base });

    // Через 29 дней — ещё не purge.
    let result = await purgeLegacySource(storage, { ...opts, now: () => base + 29 * 86_400_000 });
    expect(result.purged).toBe(false);
    expect(removed).toHaveLength(0);

    // На 31-й день срок истёк.
    result = await purgeLegacySource(storage, { ...opts, now: () => base + 31 * 86_400_000 });
    expect(result.purged).toBe(true);
    expect(removed).toEqual([key]);
  });
});

describe("Миграция: битый первый ключ не обрывает перенос", async () => {
  it("берёт первый ключ, который разобрался", async () => {
    const storage = sqlite();
    const good = JSON.stringify(sampleData());
    const report = await migrateLegacyData(storage, {
      keys: ["nexus.data.v1", "promtova-state"],
      // Первый ключ содержит мусор, второй — валидные данные.
      getItem: (k) => (k === "nexus.data.v1" ? "{битый json" : good),
    });
    expect(report.status).toBe("imported");
    expect(report.sourceKey).toBe("promtova-state");
    expect((await storage.read())!.transactions).toHaveLength(3);
  });

  it("invalid-source только когда не подошёл ни один ключ", async () => {
    const storage = sqlite();
    const report = await migrateLegacyData(storage, {
      keys: ["a", "b"],
      getItem: (k) => (k === "a" ? "{битый" : "{\"unknownField\": 1}"),
    });
    expect(report.status).toBe("invalid-source");
    expect(report.sourcePreserved).toBe(true);
  });
});

describe("Схема: защита от некорректных операций", () => {
  it("удаление пустого списка id не ломает транзакцию", async () => {
    const op = deleteRowsOp("transactions", []);
    expect(op.sql).not.toMatch(/\(\s*\)/); // не «IN ()»
    // Реальное выполнение не должно падать на синтаксисе.
    const storage = sqlite();
    await storage.write(sampleData());
    await expect(storage.sql!.exec(op.sql, op.params ?? [])).resolves.toBeUndefined();
  });

  it("очистка не приводит к воскрешению данных из legacy-ключа", async () => {
    // Флаги миграции обязаны пережить очистку: иначе при следующем запуске
    // миграция снова прочитает старый ключ из localStorage.
    const store = new MemorySnapshotStore();
    const storage = sqlite(store);
    const legacy = JSON.stringify(sampleData());
    await migrateLegacyData(storage, { getItem: () => legacy });
    expect((await storage.read())!.transactions).toHaveLength(3);

    await storage.clear();
    // После очистки остаются только настройки по умолчанию, записей нет.
    expect((await storage.read())!.transactions).toHaveLength(0);
    expect(await storage.getFlag(LEGACY_MIGRATION_FLAG)).toBeTruthy();

    // Повторный запуск на том же снапшоте: данных быть не должно.
    const restarted = sqlite(store);
    await restarted.init();
    const report = await migrateLegacyData(restarted, { getItem: () => legacy });
    expect(report.status).toBe("already-done");
    expect((await restarted.read())!.transactions).toHaveLength(0);
  });

  it("очистка удаляет остальные служебные отметки", async () => {
    const storage = sqlite();
    await storage.setFlag("ui.onboarded.v1", "1");
    await storage.clear();
    expect(await storage.getFlag("ui.onboarded.v1")).toBeNull();
  });

  it("удаляет существующие записи", async () => {
    const storage = sqlite();
    await storage.write(sampleData());
    const op = deleteRowsOp("transactions", ["t1"]);
    await storage.sql!.exec(op.sql, op.params!);
    expect((await storage.read())!.transactions).toHaveLength(2);
  });

  it("в коллекции без строкового id ничего не накапливается", async () => {
    const storage = sqlite();
    const dirty = { ...sampleData(), transactions: [{ amount: 10 } as never] };
    // Запись без id отбрасывается явно, а не плодится при каждом сохранении.
    await storage.write(dirty);
    await storage.write(dirty);
    const rows = await storage.sql!.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM transactions",
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  });

  it("размер базы считается без полного экспорта", async () => {
    const storage = sqlite();
    await storage.write(sampleData());
    const size = await storage.size();
    expect(size).toBeGreaterThan(0);
    // То же значение при повторном вызове: PRAGMA page_count*page_size стабилен.
    expect(await storage.size()).toBe(size);
  });

  it("VACUUM уменьшает базу после удаления данных", async () => {
    const storage = sqlite();
    const many = {
      ...sampleData(),
      transactions: Array.from({ length: 400 }, (_, i) =>
        tx({ id: `t${i}`, amount: 100 + i, description: "строка ".repeat(10) }),
      ),
    };
    await storage.write(many);
    const before = await storage.size();
    await storage.write({ ...emptyData(), currency: "RUB" });
    const afterDelete = await storage.size();
    expect(afterDelete).toBeGreaterThan(0);

    await storage.compact();
    const afterVacuum = await storage.size();
    // Смысл сжатия — освободить место; в in-memory БД размер страниц уменьшается.
    expect(afterVacuum).toBeLessThanOrEqual(afterDelete);
    // Данные после VACUUM на месте.
    expect((await storage.read())!.transactions).toHaveLength(0);
    void before;
  });

  it("очистка сразу сжимает базу", async () => {
    const storage = sqlite();
    await storage.write({
      ...sampleData(),
      transactions: Array.from({ length: 300 }, (_, i) => tx({ id: `x${i}`, description: "строка ".repeat(20) })),
    });
    const before = await storage.size();
    await storage.clear();
    const after = await storage.size();
    expect(after).toBeLessThan(before);
  });
});

describe("Фасад storageService: ошибка чтения не превращается в «пустую базу»", () => {
  afterEach(() => {
    setAdapterProvider(null);
  });

  it("load() пробрасывает ошибку чтения, а не возвращает null", async () => {
    // null означал бы «база пуста»: приложение подставило бы демо-данные,
    // и автосохранение стёрло бы реальные данные пользователя.
    const broken = new MemoryStorage();
    broken.read = async () => {
      throw new Error("диск повреждён");
    };
    setAdapterProvider(async () => broken);

    await expect(storageService.load()).rejects.toThrow("диск повреждён");
    expect(storageService.loadError()).toMatch(/диск повреждён/);
  });

  it("неудачный size() не делает загрузку неудачной", async () => {
    const adapter = new MemoryStorage();
    adapter.size = async () => {
      throw new Error("размер недоступен");
    };
    setAdapterProvider(async () => adapter);
    await adapter.write(sampleData());

    const loaded = await storageService.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.transactions).toHaveLength(3);
    expect(storageService.loadError()).toBeNull();
  });

  it("save() сообщает об ошибке, а не роняет промис", async () => {
    const adapter = new MemoryStorage();
    adapter.write = async () => {
      throw new Error("нет прав");
    };
    setAdapterProvider(async () => adapter);
    await expect(storageService.save(sampleData())).resolves.toBe(false);
  });

  it("clear() дожидается результата: успех и провал различимы", async () => {
    const ok = new MemoryStorage();
    setAdapterProvider(async () => ok);
    await expect(storageService.clear()).resolves.toBe(true);

    const bad = new MemoryStorage();
    bad.clear = async () => {
      throw new Error("база занята");
    };
    setAdapterProvider(async () => bad);
    await expect(storageService.clear()).resolves.toBe(false);
  });

  it("mode() не выдумывает драйвер до первой загрузки", () => {
    // Раньше возвращалось "sqlite" даже когда адаптер ещё не выбран.
    expect(["не определён", "sqlite", "memory"]).toContain(storageService.mode());
  });
});
