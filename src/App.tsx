// src/App.tsx
import { Suspense, lazy } from "react";
import { AppShell } from "./components/AppShell";
import { Onboarding } from "./components/Onboarding";
import { TransactionModal } from "./components/TransactionModal";
import { ToastHost } from "./components/ui";
import { AppProvider, useApp } from "./hooks/AppProvider";
import { useCapabilities } from "./hooks/useCapabilities";
import { OverlayStackProvider, useOverlayStack } from "./hooks/useOverlayStack";
import { usePlatformBackButton } from "./hooks/usePlatformBackButton";
import { DevTools } from "./components/DevTools";
import { Dashboard } from "./views/Dashboard";

// Экраны грузятся по требованию (ТЗ п. 5.1 «ленивая инициализация»).
// Дашборд остаётся в основном бандле — он показывается сразу после старта,
// а сканер тянет за собой jsqr и tesseract и в самое начало попадать не должен.
const Transactions = lazy(() => import("./views/Transactions").then((m) => ({ default: m.Transactions })));
const Payments = lazy(() => import("./views/Payments").then((m) => ({ default: m.Payments })));
const Confirm = lazy(() => import("./views/Payments").then((m) => ({ default: m.Confirm })));
const BudgetView = lazy(() => import("./views/Planning").then((m) => ({ default: m.BudgetView })));
const GoalsView = lazy(() => import("./views/Planning").then((m) => ({ default: m.GoalsView })));
const Investments = lazy(() => import("./views/Investments").then((m) => ({ default: m.Investments })));
const Scanner = lazy(() => import("./views/Scanner").then((m) => ({ default: m.Scanner })));
const Settings = lazy(() => import("./views/Settings").then((m) => ({ default: m.Settings })));

// 🔥 Подключаем типы для Electron API
import "./lib/electronApi";

function CurrentView() {
  const { tab } = useApp();
  switch (tab) {
    case "dashboard": return <Dashboard />;
    case "transactions": return <Transactions />;
    case "payments": return <Payments />;
    case "confirm": return <Confirm />;
    case "budget": return <BudgetView />;
    case "goals": return <GoalsView />;
    case "investments": return <Investments />;
    case "scanner": return <Scanner />;
    case "settings": return <Settings />;
  }
}

/** Заглушка на время подгрузки экрана: без анимаций, чтобы не жечь кадры. */
function ViewSkeleton() {
  return (
    <div className="space-y-4 p-1" aria-busy="true" aria-live="polite">
      <div className="h-8 w-56 rounded-lg" style={{ background: "var(--line)" }} />
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-24 rounded-xl" style={{ background: "var(--line)", opacity: 1 - i * 0.12 }} />
        ))}
      </div>
    </div>
  );
}

function Root() {
  const { tab, go, txModal, closeTxModal } = useApp();
  const overlays = useOverlayStack();
  // Определяем возможности устройства один раз и вешаем data-perf/data-motion
  // на <html> — по ним CSS отключает размытие и анимации на слабых устройствах
  useCapabilities();
  /**
   * Аппаратная кнопка «Назад», строго по убыванию приоритета:
   *
   *   1) верхний открытый оверлей из стека (hooks/useOverlayStack) — любой
   *      диалог: все окна на Modal (вместе с ConfirmDialog и модалкой
   *      транзакции), онбординг, камера сканера, панель выделения и фильтров
   *      в журнале. Раньше эти ~10 диалогов закрывались только Esc, которого
   *      на телефоне нет, а «Назад» уводил на «Обзор» — компонент с диалогом
   *      размонтировался, и введённое терялось;
   *   2) модалка транзакции — страховка: она тоже Modal и в стеке, но её
   *      состояние в контексте меняется раньше, чем отработает эффект
   *      регистрации, а лишняя проверка стоит две строки;
   *   3) смена вкладки: с любого раздела — на «Обзор»;
   *   4) на «Обзоре» без открытых оверлеев canHandle возвращает false, и мост
   *      сам выпускает нажатие в систему (passBackToSystem в
   *      android/capacitorBridge.ts) — как и раньше.
   *
   * Порядок 1 → 3 переставлять нельзя: сначала закрывается то, что поверх
   * экрана, и только потом уходит сам экран. Шторка «Ещё» отвечает ещё раньше —
   * её обрабатывает backRouter.shell в AppShell, второй нативной подписки
   * быть не может (см. комментарий там), поэтому в стек она не встаёт.
   */
  usePlatformBackButton(
    () => overlays.top() !== null || txModal.open || tab !== "dashboard",
    () => {
      const closeTop = overlays.top();
      if (closeTop) {
        closeTop();
        return;
      }
      if (txModal.open) {
        closeTxModal();
        return;
      }
      if (tab !== "dashboard") go("dashboard");
    },
  );
  return (
    <>
      <AppShell>
        <div key={tab} className="view-anim">
          <Suspense fallback={<ViewSkeleton />}>
            <CurrentView />
          </Suspense>
        </div>
      </AppShell>
      <TransactionModal />
      <ToastHost />
      <Onboarding />
      <DevTools />
    </>
  );
}

export default function App() {
  return (
    // Стек оверлеев — инфраструктура, а не часть данных приложения: он ничего
    // не знает про AppProvider, поэтому стоит выше. Его ref переживает любые
    // перерисовки, так что открытый диалог остаётся в стеке, даже когда
    // AppProvider отдаёт новый объект состояния.
    <OverlayStackProvider>
      <AppProvider>
        <Root />
      </AppProvider>
    </OverlayStackProvider>
  );
}
