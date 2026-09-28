// src/views/Settings.tsx
import {
  Database, Download, HardDrive, MonitorSmartphone,
  RefreshCw, Trash2, Upload, Type, Palette,
  FolderOpen, DownloadCloud, PackageCheck, ExternalLink, FlaskConical, ShieldAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useApp } from "../hooks/AppProvider";
import { useCapabilities } from "../hooks/useCapabilities";
import { ConfirmDialog, PageHeader, ProgressBar } from "../components/ui";
import { CURRENCIES, FONT_SCALES, THEMES, APP_VERSION } from "../lib/constants";
import { readSymbol } from "../lib/utils";
import { storageInfo, storageService } from "../lib/storage";
import type { StorageDescription } from "../storage";
import { describeTier } from "../platform/capabilities";
import { platform } from "../platform";
import { LicenseLink } from "../components/LicenseDialog";
import { BETA_NOTE, isBetaVersion, updateModeNote, useUpdater } from "../lib/updater";
import type { PlatformBridge } from "../platform/types";
import type { Currency, Theme } from "../lib/types";
import { cn } from "../utils/cn";

function Section({ title, icon: Icon, children }: { title: string; icon: typeof Palette; children: React.ReactNode }) {
  return (
    <section className="card cut p-5 rise-in">
      <header className="card-head">
        <h2 className="card-title">{title}</h2>
        <span className="card-sub"><Icon size={14} /></span>
      </header>
      {children}
    </section>
  );
}

/** Байты человеческим языком: 1.5 МБ, 812 КБ. Для прогресса загрузки. */
const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 КБ";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
};

/**
 * Пункт «Обновления»: проверка, скачивание и установка — только по кнопке.
 *
 * В этом компоненте нет ни одного эффекта и ни одного таймера, которые трогали
 * бы сеть: единственное, что обращается к GitHub, — обработчик кнопки
 * «Проверить обновления». Ни при открытии настроек, ни при возврате на экран,
 * ни при запуске программы проверки не происходит.
 *
 * Порядок кнопок повторяет решение пользователя: сначала узнать, есть ли
 * новая версия, потом скачать, потом поставить. Каждая следующая кнопка
 * появляется только после того, как предыдущая сделана, — лишних кнопок,
 * которые ничего не делают, на экране нет.
 */
function UpdateSection({
  bridge,
  appVersion,
  notify,
}: {
  bridge: PlatformBridge;
  appVersion: string;
  notify: (text: string, kind?: "success" | "error" | "info") => void;
}) {
  const { status, busy, check, download, install, openReleases } = useUpdater(bridge, appVersion);
  const isBeta = isBetaVersion(appVersion);

  // В браузере обновлений нет вовсе, поэтому кнопку проверки не показываем
  // совсем: серая кнопка, которая ничего не делает, выглядит как поломка.
  const canCheck = status.mode !== "unsupported";
  const showDownload = status.phase === "available";
  const showInstall = status.phase === "downloaded";
  const isProblem = status.phase === "failed" || status.phase === "access-denied";
  // Предупреждение о подписи показываем ровно тогда, когда оно что-то значит:
  // либо найдена новая версия, либо файл уже скачан.
  const warnSignature = status.signatureUnverified && (status.phase === "available" || status.phase === "downloaded");

  // Кнопки, результат которых логичен (true/false), сообщают о неудаче тостом:
  // сам текст ошибки у них нет — его знает только главный процесс.
  const reportFailure = (action: string) => (ok: boolean) => {
    if (!ok) notify(action, "error");
  };

  return (
    <Section title="Обновления" icon={DownloadCloud}>
      <div className="flex flex-wrap items-center gap-2.5">
        {isBeta ? (
          <span
            className="badge"
            style={{
              borderColor: "var(--warn)",
              color: "var(--warn)",
              background: "color-mix(in srgb, var(--warn) 14%, transparent)",
            }}
          >
            <FlaskConical size={12} aria-hidden /> Бета · v{appVersion}
          </span>
        ) : (
          <span className="badge" style={{ borderColor: "var(--line)", color: "var(--muted)" }}>
            v{appVersion}
          </span>
        )}
        <span className="text-xs" style={{ color: "var(--muted)" }}>
          Установленная версия: <span className="mono">v{appVersion}</span>
        </span>
      </div>

      <p className="text-sm mt-3" style={{ color: "var(--muted)" }}>{updateModeNote(status.mode)}</p>
      {isBeta ? (
        <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>{BETA_NOTE}</p>
      ) : null}

      {/* Условия — не мелкий шрифт в подвале настроек, а обычная кнопка
          рядом с тем, чем человек пользуется. Главное из них — запрет
          распространения — должно быть под рукой, а не спрятано. */}
      <div className="mt-4">
        <LicenseLink className="btn btn-ghost" label="Условия использования" />
      </div>

      <div className="flex flex-wrap gap-2.5 mt-4">
        {canCheck ? (
          <button className="btn btn-primary" disabled={busy} onClick={() => void check()}>
            <RefreshCw size={15} />
            {busy && status.phase === "checking" ? "Проверяю…" : "Проверить обновления"}
          </button>
        ) : null}
        {showDownload ? (
          <button className="btn btn-ghost" disabled={busy} onClick={() => void download()}>
            <Download size={15} /> Скачать{status.availableVersion ? ` v${status.availableVersion}` : ""}
          </button>
        ) : null}
        {showInstall ? (
          <button
            className="btn btn-ok"
            disabled={busy}
            onClick={() => void install().then(reportFailure("Не удалось запустить установку обновления"))}
          >
            <PackageCheck size={15} /> Установить и перезапустить
          </button>
        ) : null}
        {/* Ссылка на релиз доступна всегда: это единственный путь к новой версии,
            когда автоматика недоступна (закрытый репозиторий) или невозможна
            (Android). На время загрузки её не блокируем — она никому не мешает. */}
        <button
          className="btn btn-ghost"
          onClick={() => void openReleases().then(reportFailure("Не удалось открыть страницу релиза"))}
        >
          <ExternalLink size={15} /> Открыть страницу релиза в браузере
        </button>
      </div>

      {status.progress ? (
        <div
          className="mt-4"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={status.progress.percent}
          aria-valuetext={`Скачано ${status.progress.percent} процентов`}
        >
          <ProgressBar pct={status.progress.percent} />
          <p className="text-xs mt-1.5" style={{ color: "var(--muted)" }}>
            Скачано {status.progress.percent}% · {formatBytes(status.progress.transferred)} из {formatBytes(status.progress.total)}
          </p>
        </div>
      ) : null}

      {/* aria-live: сообщение меняется по ходу проверки и загрузки, и о нём
          должен узнать экранный диктор, даже если пользователь смотрит в
          другую часть экрана. aria-atomic — чтобы он прочитал текст целиком,
          а не только изменившееся слово. */}
      <p
        className="text-sm mt-4 break-words"
        style={{ color: isProblem ? "var(--danger)" : "var(--text)" }}
        aria-live="polite"
        aria-atomic="true"
      >
        {status.message}
      </p>

      {warnSignature ? (
        <div
          className="mt-3 text-xs p-3 rounded-lg flex gap-2 items-start break-words"
          style={{ border: "1px solid var(--warn)", color: "var(--warn)" }}
        >
          <ShieldAlert size={15} className="shrink-0 mt-0.5" aria-hidden />
          <span>
            Сборка не подписана, поэтому подпись установщика никто не проверил: electron-updater
            такую проверку молча пропускает и сказать «проверено» не может. Если сомневаетесь —
            откройте страницу релиза и скачайте файл оттуда.
          </span>
        </div>
      ) : null}

      {status.releaseNotes ? (
        <details className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
          <summary className="link cursor-pointer">
            Что нового{status.availableVersion ? ` в версии ${status.availableVersion}` : ""}
          </summary>
          <p className="mt-2 whitespace-pre-wrap break-words">{status.releaseNotes}</p>
        </details>
      ) : null}

      {status.checkedAt ? (
        <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>
          Последняя проверка:{" "}
          <span className="mono">
            {new Date(status.checkedAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}
          </span>
        </p>
      ) : null}
    </Section>
  );
}

export function Settings() {
  const { data, setTheme, setCurrency, setFontScale, exportNow, importFromFile, clearAll, loadDemo, notify, loadBlocked, retryLoad } = useApp();
  const [confirmClear, setConfirmClear] = useState(false);

  // Все действия, зависящие от ОС, идут через мост: страница не знает,
  // Windows это, Android или браузер.
  const bridge = platform();
  const [appVersion, setAppVersion] = useState(APP_VERSION);
  const [tray, setTray] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void bridge
      .appVersion()
      .then((v) => {
        if (!cancelled && v) setAppVersion(v);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  // 🔥 Обновлённый раздел «Хранилище»
  const info = storageInfo();
  const caps = useCapabilities();
  const [store, setStore] = useState<StorageDescription | null>(null);
  const [compacting, setCompacting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void storageService
      .description()
      .then((d) => {
        if (!cancelled) setStore(d);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [data]);

  const totalRecords =
    data.transactions.length + data.subscriptions.length + data.fixedPayments.length +
    data.budgets.length + data.goals.length + data.investments.length;

  const isDesktop = bridge.native;
  // «Тип установки» по виду платформы, а не по bridge.native: у Android-контейнера
  // native тоже true, но называть его десктопным приложением неверно.
  const installKindLabel =
    bridge.kind === "android" || bridge.kind === "ios"
      ? "Мобильное приложение"
      : isDesktop
        ? "Десктопное приложение"
        : "Веб-версия";
  // Открыть папку с данными умеет только десктопный контейнер (в Electron это
  // Проводник). В Android-контейнере папки, которую можно «показать», нет, и
  // мост честно сообщает об этом признаком features.dataFolder === false —
  // тогда вместо кнопки показываем настоящий путь к данным.
  const canOpenDataFolder = isDesktop && bridge.features.dataFolder !== false;
  const bytes = store?.bytes ?? info.bytes;
  const lockedReason = store?.locked ?? null;
  const platformLabel: Record<string, string> = {
    windows: "Windows",
    android: "Android",
    ios: "iOS",
    macos: "macOS",
    linux: "Linux",
    web: "Браузер",
  };
  const migrationLabel: Record<string, string> = {
    imported: "данные перенесены из localStorage",
    "already-done": "перенос уже выполнялся",
    "no-source": "перенос не требовался",
    "invalid-source": "старые данные не распознаны",
    failed: "перенос не удался",
  };

  return (
    <div className="space-y-5 max-w-4xl">
      <PageHeader kicker="Конфигурация" title="Настройки" />

      <Section title="Тема оформления" icon={Palette}>
        <div className="grid sm:grid-cols-3 gap-3">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={cn("theme-card", data.theme === t.id && "theme-card-active")}
              onClick={() => setTheme(t.id as Theme)}
              aria-pressed={data.theme === t.id}
            >
              <span className="flex gap-1.5" aria-hidden>
                {t.swatch.map((c) => (
                  <i key={c} className="w-5 h-5 rounded-[4px]" style={{ background: c, border: "1px solid var(--line)" }} />
                ))}
              </span>
              <span className="block text-sm font-semibold mt-3" style={{ color: "var(--text)" }}>{t.label}</span>
              <span className="block text-[11px] mt-0.5" style={{ color: "var(--muted)" }}>{t.desc}</span>
            </button>
          ))}
        </div>
      </Section>

      <div className="grid md:grid-cols-2 gap-5">
        <Section title="Валюта" icon={Database}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {(Object.keys(CURRENCIES) as Currency[]).map((c) => (
              <button
                key={c}
                className={cn("chip-big", data.currency === c && "chip-big-active")}
                onClick={() => setCurrency(c)}
                aria-pressed={data.currency === c}
              >
                <span className="mono font-bold">{readSymbol(c)}</span>
                {/* Название валюты — из данных констант, но строки бывают
                    длиннее плитки: перенос вместо выхода за границу. */}
                <span className="min-w-0 break-words">{c} · {CURRENCIES[c].label}</span>
              </button>
            ))}
          </div>
        </Section>

        <Section title="Масштаб шрифта" icon={Type}>
          <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>Увеличьте интерфейс, если текст кажется мелким.</p>
          <div className="flex gap-2.5">
            {FONT_SCALES.map((s) => (
              <button
                key={s.value}
                className={cn("chip-big flex-1 justify-center", data.fontScale === s.value && "chip-big-active")}
                onClick={() => setFontScale(s.value)}
                aria-pressed={data.fontScale === s.value}
              >
                <span className="mono font-bold">{s.label}</span>
              </button>
            ))}
          </div>
          <p className="text-sm mt-4" style={{ color: "var(--muted)" }}>Навигация полностью доступна с клавиатуры: Tab, Enter, Alt+N — новая транзакция.</p>
        </Section>
      </div>

      <Section title="Данные и бэкап" icon={HardDrive}>
        <div className="flex flex-wrap gap-2.5">
          <button className="btn btn-primary" onClick={() => void exportNow()}><Download size={15} /> Экспорт в JSON</button>
          <button className="btn btn-ghost" onClick={() => void importFromFile()}><Upload size={15} /> Импорт из JSON</button>
          <button className="btn btn-ghost" onClick={loadDemo}><RefreshCw size={15} /> Загрузить демо-данные</button>
          <button className="btn btn-danger" onClick={() => setConfirmClear(true)}><Trash2 size={15} /> Очистить все данные</button>
        </div>
        <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>
          Импорт объединяет данные без дубликатов по ID. Экспорт сохраняет полный снимок: транзакции, платежи, бюджеты, цели, инвестиции и настройки.
        </p>
      </Section>

      {/* Обновления — сразу под бэкапом: обе вещи про «мою копию данных», и
          перед обновлением разумно иметь свежий экспорт. */}
      <UpdateSection bridge={bridge} appVersion={appVersion} notify={notify} />

      {/* 🔥 Новый раздел «Хранилище» (без технической шелухи) */}
      <Section title="Хранилище данных" icon={MonitorSmartphone}>
        <dl className="grid sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
          {/* Строки сетки: min-w-0 не даёт длинному значению растянуть колонку,
              flex-wrap + break-words на dd — перенести его, а не вывести за
              пределы ячейки («sqlite · постоянное», «204.0 КБ», счётчик). */}
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 min-w-0">
            <dt style={{ color: "var(--muted)" }}>Тип установки</dt>
            <dd className="min-w-0 break-words text-right" style={{ color: "var(--text)" }}>
              {installKindLabel}
            </dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 min-w-0">
            <dt style={{ color: "var(--muted)" }}>Платформа</dt>
            <dd className="mono min-w-0 break-words text-right" style={{ color: "var(--text)" }}>
              {platformLabel[bridge.kind] ?? bridge.kind} · v{appVersion}
            </dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 min-w-0">
            <dt style={{ color: "var(--muted)" }}>Место хранения данных</dt>
            <dd className="min-w-0 break-words text-right" style={{ color: "var(--text)" }}>
              {canOpenDataFolder ? (
                <button
                  className="link flex items-center gap-1.5"
                  onClick={() => {
                    // Папку с файлом SQLite открывает мост (в Electron — Проводник)
                    void bridge.openDataFolder().then((opened) => {
                      if (!opened) notify(bridge.storageHint(), "info");
                    });
                  }}
                >
                  <FolderOpen size={14} />
                  Открыть папку с данными
                </button>
              ) : (
                // Честный путь вместо надписи «В браузере»: в Android-контейнере
                // это приватное хранилище приложения, а не браузер.
                <span className="mono">{bridge.storageHint()}</span>
              )}
            </dd>
          </div>
          {bridge.features.tray ? (
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 min-w-0">
              <dt style={{ color: "var(--muted)" }}>Значок в трее</dt>
              <dd className="min-w-0 break-words text-right" style={{ color: "var(--text)" }}>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={tray}
                    onChange={async (e) => {
                      const next = e.target.checked;
                      const ok = await bridge.setTray(next);
                      setTray(ok ? next : false);
                      if (!ok) notify("Система не разрешила создать значок в трее", "error");
                    }}
                  />
                  {tray ? "Включён — приложение живёт в фоне" : "Выключен"}
                </label>
              </dd>
            </div>
          ) : null}
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 min-w-0">
            <dt style={{ color: "var(--muted)" }}>Хранилище</dt>
            <dd className="mono min-w-0 break-words text-right" style={{ color: "var(--text)" }}>
              {store ? `${store.driver}${store.persistent ? " · постоянное" : " · временное"}` : '…'}
            </dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 min-w-0">
            <dt style={{ color: "var(--muted)" }}>Журнал SQLite</dt>
            <dd className="mono min-w-0 break-words text-right" style={{ color: "var(--text)" }}>{store?.journalMode ?? '…'}</dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 min-w-0">
            <dt style={{ color: "var(--muted)" }}>Версия схемы</dt>
            <dd className="mono min-w-0 break-words text-right" style={{ color: "var(--text)" }}>{store?.version ?? '…'}</dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 min-w-0">
            <dt style={{ color: "var(--muted)" }}>Размер базы</dt>
            <dd className="mono min-w-0 break-words text-right" style={{ color: "var(--text)" }}>{(bytes / 1024).toFixed(1)} КБ</dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 min-w-0">
            <dt style={{ color: "var(--muted)" }}>Записей всего</dt>
            <dd className="mono min-w-0 break-words text-right" style={{ color: "var(--text)" }}>{totalRecords.toLocaleString("ru-RU")}</dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 min-w-0">
            <dt style={{ color: "var(--muted)" }}>Режим графики</dt>
            <dd className="min-w-0 break-words text-right" style={{ color: "var(--text)" }}>{describeTier(caps)}</dd>
          </div>
          {store?.legacyBackup ? (
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 min-w-0">
              <dt style={{ color: "var(--muted)" }}>Откат на старые данные</dt>
              <dd className="mono min-w-0 break-words text-right" style={{ color: "var(--text)" }}>
                {store.legacyBackup.expired
                  ? "срок истёк, резервная копия удалена"
                  : `ещё ${store.legacyBackup.daysLeft} дн.`}
              </dd>
            </div>
          ) : null}
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 min-w-0">
            <dt style={{ color: "var(--muted)" }}>Обслуживание базы</dt>
            <dd className="min-w-0 break-words text-right" style={{ color: "var(--text)" }}>
              <button
                className="link"
                disabled={compacting}
                onClick={async () => {
                  setCompacting(true);
                  const ok = await storageService.compact();
                  setCompacting(false);
                  if (ok) {
                    const d = await storageService.description();
                    setStore(d);
                    notify(`База сжата: ${(d.bytes / 1024).toFixed(1)} КБ`);
                  } else {
                    notify("Не удалось сжать базу", "error");
                  }
                }}
              >
                {compacting ? "Сжимаю…" : "Сжать базу (VACUUM)"}
              </button>
            </dd>
          </div>
        </dl>
        <p className="text-xs mt-4 pt-3 border-t" style={{ borderColor: "var(--line)", color: "var(--muted)" }}>
          {store?.migration && migrationLabel[store.migration]
            ? `Хранилище SQLite: ${migrationLabel[store.migration]}.`
            : 'Данные хранятся локально в SQLite и не покидают устройство.'}
        </p>
        {/* Проблемы хранилища показываем явно: молчаливая подмена «всё хорошо»
            приводила к потере данных. */}
        {store?.readError || store?.persistError || lockedReason ? (
          <div
            className="mt-3 text-xs p-3 rounded-lg break-words"
            style={{ border: "1px solid var(--danger)", color: "var(--danger)" }}
          >
            {store?.readError ? `Не удалось прочитать базу: ${store.readError}. Данные не перезаписаны.` : null}
            {store?.persistError ? ` Последняя запись не сохранена: ${store.persistError}.` : null}
            {lockedReason ? ` ${lockedReason}` : null}
            {loadBlocked ? (
              <button className="link ml-2" onClick={() => void retryLoad()}>
                Повторить чтение
              </button>
            ) : null}
          </div>
        ) : null}
      </Section>

      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Удалить все данные?"
        text="Транзакции, подписки, бюджеты, цели и инвестиции будут безвозвратно удалены из локального хранилища. Рекомендуем сначала сделать экспорт в JSON."
        confirmLabel="Да, удалить всё"
        onConfirm={clearAll}
      />
    </div>
  );
}