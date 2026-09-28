// src/components/AppShell.tsx
import {
  ArrowLeftRight, CalendarClock, Check, CheckCircle2, FlaskConical, Gauge, MoreHorizontal, Plus,
  ScanLine, Settings2, Target, TrendingUp, Wallet, type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useApp } from "../hooks/AppProvider";
import { APP_VERSION } from "../lib/constants";
import { isActionablePending } from "../lib/engine";
import type { Tab } from "../lib/types";
import { isBetaVersion } from "../lib/updater";
import { platform } from "../platform";
import { cn } from "../utils/cn";
import { BoostyIcon, TelegramIcon } from "./BrandIcons";
import { LicenseLink } from "./LicenseDialog";
import { BottomSheet } from "./ui";

const NAV: { tab: Tab; label: string; icon: LucideIcon }[] = [
  { tab: "dashboard", label: "Обзор", icon: Gauge },
  { tab: "transactions", label: "Транзакции", icon: ArrowLeftRight },
  { tab: "payments", label: "Платежи", icon: CalendarClock },
  { tab: "confirm", label: "Подтвердить", icon: CheckCircle2 },
  { tab: "budget", label: "Бюджет", icon: Wallet },
  { tab: "goals", label: "Цели", icon: Target },
  { tab: "investments", label: "Инвестиции", icon: TrendingUp },
  { tab: "scanner", label: "Сканер чеков", icon: ScanLine },
  { tab: "settings", label: "Настройки", icon: Settings2 },
];

/**
 * Разделы нижней ленты на телефоне.
 *
 * В ленту помещается пять пунктов: четыре самых частых и «Ещё», открывающий
 * шторку со всеми девятью. Выбор — по частоте: обзор (куда попадаешь при
 * запуске), транзакции (журнал операций — главный экран учёта), платежи
 * (расписание) и подтверждения (единственный пункт со счётчиком невыполненного
 * — если он не виден сразу, о нём легко забыть). Бюджет, цели, инвестиции,
 * сканер и настройки открывают реже, но остаются в шторке в один тап.
 *
 * Список НЕ продублирован: подписи, иконки и порядок берутся из NAV, здесь
 * только четыре id. Новый раздел добавляется одним изменением — он сам
 * попадёт в шторку (NAV.map), а в ленту — если его id дописать здесь.
 */
const PRIMARY_TABS: Tab[] = ["dashboard", "transactions", "payments", "confirm"];

/* ── Аппаратная кнопка «Назад» ──────────────────────────────────────────────
 *
 * Обработчик в приложении один: usePlatformBackButton (src/App.tsx) закрывает
 * модалку транзакции, иначе возвращает на «Обзор», а с «Обзора» отдаёт
 * нажатие системе (см. passBackToSystem в android/capacitorBridge.ts).
 *
 * Шторке «Ещё» нужен ещё один, более приоритетный обработчик — но вторая
 * подписка на backButton недопустима: Capacitor раздаёт одно нативное событие
 * ВСЕМ подписчикам (@capacitor/core, notifyListeners: listeners.forEach), и
 * мост после каждого вызова смотрит на результат — вернувший false вызывает
 * passBackToSystem. Вторая подписка означала бы, что «Назад» со шторкой
 * закрыл бы её И вышел бы из приложения.
 *
 * Поэтому onBackButton перехватывается ровно один раз: нативная подписка
 * заводится здесь, обработчик приложения кладётся в запасной слот и
 * вызывается, только если шторка не ответила. Пока шторка закрыта, поведение
 * «назад» — ровно прежнее, включая выход с «Обзора» в систему.
 *
 * Перехват ставится на уровне модуля, а не в эффекте: он обязан встать ДО
 * useEffect в App.tsx, и порядок эффектов был бы единственной гарантией.
 * Мост — синглтон, а подписка живёт столько же, сколько приложение (Root не
 * размонтируется), поэтому и снимать её не нужно.
 *
 * Если появится правка самого App.tsx — дописать шторку в его canHandle/onBack
 * и поднять состояние шторки наверх — этот перехват просто удаляется, он
 * ничего не блокирует.
 */
type BackHandler = () => boolean;

const backRouter: { shell: BackHandler | null; app: BackHandler | null } = {
  shell: null,
  app: null,
};
let backRouterInstalled = false;

const installBackRouter = (): void => {
  if (backRouterInstalled) return;
  backRouterInstalled = true;
  const bridge = platform();
  // Кнопки «Назад» нет ни в браузере, ни в Electron — перехватывать нечего.
  if (!bridge.features.backButton) return;
  const nativeSubscribe = bridge.onBackButton.bind(bridge);
  bridge.onBackButton = (handler) => {
    backRouter.app = handler;
    return () => {
      if (backRouter.app === handler) backRouter.app = null;
    };
  };
  nativeSubscribe(() => {
    const shell = backRouter.shell;
    if (shell && shell()) return true;
    const app = backRouter.app;
    return app ? app() : false;
  });
};

installBackRouter();

function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-1">
      {/* 🔥 Кодовый логотип без img */}
      {/* clip-path и контур берёт класс .hex: рамку в разметке не ставим,
          иначе поверх inset-тени ляжет вторая тонкая линия. */}
      <span
        className="hex hex-logo flex items-center justify-center"
        style={{
          width: 38,
          height: 38,
          background: "linear-gradient(160deg, color-mix(in srgb, var(--accent) 28%, transparent), color-mix(in srgb, var(--pink) 14%, transparent))",
          color: "var(--accent)",
        }}
      >
        <span className="font-display font-bold text-[18px]" style={{ color: "var(--accent)" }}>$</span>
      </span>
      <div className="leading-none">
        <span className="font-display font-extrabold text-[15px] tracking-[0.22em]" style={{ color: "var(--ink)" }}>
          NEXUS
        </span>
        <span className="block text-[9px] tracking-[0.34em] mt-1 uppercase" style={{ color: "var(--accent)" }}>
          finance
        </span>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { tab, go, data, openTxModal } = useApp();
  // Бейдж показывает только платежи, которые нужно подтвердить сейчас.
  // Платежи будущих месяцев создаются заранее (чтобы не потерять пропущенный
  // месяц) и в бейдж не попадают — иначе он горел бы постоянно.
  const pendingCount = useMemo(
    () => data.pendingPayments.filter((p) => isActionablePending(p)).length,
    [data.pendingPayments],
  );

  // Пункты ленты выводятся из NAV (порядок и подписи — оттуда же).
  const primaryNav = useMemo(() => NAV.filter((n) => PRIMARY_TABS.includes(n.tab)), []);
  // Текущий раздел не в ленте → подсвечиваем «Ещё», иначе непонятно, где мы.
  const inBar = useMemo(() => PRIMARY_TABS.includes(tab), [tab]);
  // Шторка «Ещё» со всеми разделами.
  const [moreOpen, setMoreOpen] = useState(false);
  const moreOpenRef = useRef(moreOpen);
  moreOpenRef.current = moreOpen;

  // Аппаратная кнопка «Назад»: шторка отвечает первой (см. backRouter выше).
  // Обработчик один и не переподписывается — на «Назад» он просто читает актуальный флаг.
  useEffect(() => {
    backRouter.shell = () => {
      if (!moreOpenRef.current) return false;
      moreOpenRef.current = false;
      setMoreOpen(false);
      return true;
    };
    return () => {
      backRouter.shell = null;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Горячие клавиши работают и при открытой шторке — тогда её надо закрыть,
      // иначе поверх нового экрана останется висящее меню.
      if (e.altKey && (e.key === "n" || e.key === "N" || e.key === "т" || e.key === "Т")) {
        e.preventDefault();
        setMoreOpen(false);
        openTxModal();
      }
      
      if (e.altKey && e.key >= '1' && e.key <= '9') {
        const index = parseInt(e.key) - 1;
        if (index < NAV.length) {
          e.preventDefault();
          setMoreOpen(false);
          go(NAV[index].tab);
        }
      }
      
      if (e.ctrlKey && e.key === 'Home') {
        e.preventDefault();
        setMoreOpen(false);
        go('dashboard');
      }
    };
    
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openTxModal, go]);

  return (
    <>
    {/* Фон у корня намеренно не задан: .app-bg лежит на z-index: -1, и
        непрозрачный bg-[var(--bg)] на корне нарисовался бы ПОВЕРХ него,
        закрыв сетку, свечения и сканирующую линию. */}
    <div className="flex h-screen max-h-screen w-full overflow-hidden text-[var(--ink)]">

      {/* ── Анимированный фон: сетка, два свечения и бегущая сканирующая линия.
          Слой чисто декоративный (aria-hidden + pointer-events: none в CSS),
          клики и скролл не перехватывает. ── */}
      <div className="app-bg" aria-hidden="true">
        <span className="app-bg-grid" />
        <span className="app-bg-glow app-bg-glow-a" />
        <span className="app-bg-glow app-bg-glow-b" />
        <span className="app-bg-scan" />
      </div>

      <aside className="sidebar relative flex flex-col flex-shrink-0 w-[240px] h-full border-r border-[var(--line)] bg-[color-mix(in_srgb,var(--bg)_80%,transparent)] backdrop-blur-[18px] z-30 p-4">
        <Logo />
        
        <nav className="flex-1 space-y-1 overflow-y-auto pr-1 mt-6" aria-label="Разделы">
          {NAV.map((n) => (
            <button
              key={n.tab}
              className={cn("nav-item", tab === n.tab && "nav-item-active")}
              onClick={() => go(n.tab)}
              aria-current={tab === n.tab ? "page" : undefined}
            >
              <n.icon size={17} strokeWidth={1.9} />
              <span className="flex-1 text-left">{n.label}</span>
              {n.tab === "confirm" && pendingCount > 0 && (
                <span className="nav-badge pulse-soft">{pendingCount}</span>
              )}
            </button>
          ))}
        </nav>
        
        <div className="mt-auto pt-4 border-t border-[var(--line)] flex flex-col gap-3">
          <button className="btn btn-primary w-full justify-center" onClick={() => openTxModal()}>
            <Plus size={16} strokeWidth={2.4} /> Новая транзакция
          </button>
          <div className="flex items-center justify-center gap-2 px-1 text-[10px] text-[var(--ink-2)]">
            <span className="status-dot" aria-hidden />
            <span>Локальные данные · v{APP_VERSION}</span>
          </div>
        </div>
      </aside>

      {/* --- ОСНОВНОЙ КОНТЕНТ --- */}
      <main className="app-main flex-1 min-w-0 h-full overflow-y-auto flex flex-col p-4 sm:p-6 lg:p-8">
        {/* Мобильная шапка: на десктопе скрыта (.mobile-topbar { display: none }).
            Нужна, потому что при ≤ 900px .sidebar выключается целиком. */}
        <div className="mobile-topbar">
          <div className="flex items-center justify-between gap-3">
            <Logo />
            <div className="flex items-center gap-2 text-[10px] text-[var(--ink-2)] whitespace-nowrap">
              <span className="status-dot" aria-hidden />
              <span>Локальные данные</span>
            </div>
          </div>
          <button className="btn btn-primary w-full" onClick={() => openTxModal()}>
            <Plus size={16} strokeWidth={2.4} /> Новая транзакция
          </button>
        </div>

        <div className="max-w-7xl w-full mx-auto flex-1 flex flex-col">
          {children}
        </div>

        {/* ФУТЕР */}
        <footer className="app-footer mt-8 pt-4 border-t border-[var(--line)] flex flex-wrap items-center justify-between gap-2 text-[10px] text-[var(--ink-2)]">
          <div className="flex flex-wrap items-center gap-2">
            <span>NEXUS Finance v{APP_VERSION}</span>
            {/* Бета-видимость в футере. Значок — из той же версии, что и текст
                рядом, отдельной константы нет: как только APP_VERSION перестанет
                быть пререлизной, метка исчезнет сама. */}
            {isBetaVersion(APP_VERSION) ? (
              <span
                className="badge"
                style={{ borderColor: "var(--warn)", color: "var(--warn)" }}
                title="Бета-версия: возможны изменения и ошибки"
              >
                <FlaskConical size={10} aria-hidden /> Бета
              </span>
            ) : null}
            <span className="hidden sm:inline">·</span>
            <span>Данные локально</span>
            <span className="hidden sm:inline">·</span>
            <span className="hidden sm:inline">Electron-ready</span>
          </div>
          
          <div className="flex flex-wrap items-center gap-3">
            <a
              href="https://t.me/dev_aitech"
              target="_blank"
              rel="noopener noreferrer"
              className="footer-link"
              style={{ color: "#2AABEE" }}
              title="Telegram"
            >
              <TelegramIcon size={14} /> Telegram
            </a>
            <span className="hidden sm:inline">|</span>
            <a
              href="https://boosty.to/kpavels1997/donate"
              target="_blank"
              rel="noopener noreferrer"
              className="footer-link"
              style={{ color: "#7B2FF7" }}
              title="Boosty — платные посты с новыми сборками"
            >
              <BoostyIcon size={14} /> Boosty
            </a>
            <span className="hidden sm:inline">|</span>
            {/* Условия использования видны отсюда: запрет распространения —
                главное из них, и человек должен иметь к нему доступ сразу,
                а не искать в папке установки. Название лицензии на код
                не указываем: исходники закрыты, репозиторий приватный,
                а объявлять MIT, которого не было, незачем. */}
            <LicenseLink />
            <span className="hidden sm:inline">|</span>
            <span>© {new Date().getFullYear()} Павел К.</span>
          </div>
        </footer>
      </main>

      {/* ── Мобильная нижняя навигация: пять пунктов (см. PRIMARY_TABS) —
          четыре частых раздела и «Ещё», открывающий шторку со всеми девятью.
          position: fixed, поэтому объявлена вне <main> (вне прокрутки).
          На десктопе скрыта, на ≤ 900px — единственная навигация. ── */}
      <nav className="mobile-nav" aria-label="Разделы — мобильная навигация">
        {primaryNav.map((n) => (
          <button
            key={n.tab}
            className={cn("mobile-nav-btn", tab === n.tab && "mobile-nav-btn-active")}
            onClick={() => go(n.tab)}
            aria-current={tab === n.tab ? "page" : undefined}
            // Счётчик висит на углу иконки и для скринридера молчит, поэтому
            // его значение переносится в имя кнопки.
            aria-label={
              n.tab === "confirm" && pendingCount > 0
                ? `${n.label}: ${pendingCount} не подтверждено`
                : undefined
            }
          >
            <n.icon size={20} strokeWidth={1.9} />
            <span className="mobile-nav-label">{n.label}</span>
            {n.tab === "confirm" && pendingCount > 0 && (
              <span className="nav-badge mobile-nav-badge pulse-soft" aria-hidden>{pendingCount}</span>
            )}
          </button>
        ))}
        <button
          className={cn("mobile-nav-btn", !inBar && "mobile-nav-btn-active")}
          onClick={() => setMoreOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          // Раздел открыт из шторки — отмечаем и здесь, иначе в ленте не видно,
          // где пользователь находится.
          aria-current={inBar ? undefined : "page"}
        >
          <MoreHorizontal size={20} strokeWidth={1.9} />
          <span className="mobile-nav-label">Ещё</span>
        </button>
      </nav>
    </div>

    {/* ── Шторка «Ещё»: все девять разделов, включая те, что уже есть в ленте.
        Список берётся из NAV, поэтому новый раздел появляется здесь сам.
        Закрытие: «Назад» (backRouter.shell), затемнение, крестик, Escape,
        выбор строки. Объявлена вне корня (у него overflow: hidden), рядом с
        ним — так же, как Modal в App.tsx. ── */}
    <BottomSheet open={moreOpen} onClose={() => setMoreOpen(false)} title="Все разделы">
      <div className="sheet-list">
        {NAV.map((n) => (
          <button
            key={n.tab}
            className={cn("nav-item", tab === n.tab && "nav-item-active")}
            onClick={() => { go(n.tab); setMoreOpen(false); }}
            aria-current={tab === n.tab ? "page" : undefined}
          >
            <n.icon size={18} strokeWidth={1.9} />
            <span className="flex-1 text-left">{n.label}</span>
            {n.tab === "confirm" && pendingCount > 0 && (
              <span className="nav-badge pulse-soft">{pendingCount}</span>
            )}
            {tab === n.tab && <Check size={16} className="shrink-0" aria-hidden />}
          </button>
        ))}
      </div>
    </BottomSheet>
    </>
  );
}