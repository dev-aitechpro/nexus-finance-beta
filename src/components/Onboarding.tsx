// src/components/Onboarding.tsx
// Онбординг для нетехнических пользователей (ТЗ Группа 4):
// 4 коротких шага на русском, без терминов. Показывается один раз,
// факт завершения хранится в БД (флаг ui.onboarded.v1), а не в localStorage.
import { ArrowRight, Check, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getStorage } from "../storage";
import { useOverlay } from "../hooks/useOverlayStack";
import { cn } from "../utils/cn";
import { FocusTrap } from "./ui";

export const ONBOARDING_FLAG = "ui.onboarded.v1";

interface OnboardingStep {
  title: string;
  text: string;
}

const STEPS: OnboardingStep[] = [
  {
    title: "Деньги под контролем",
    text: "Здесь видно, сколько вы потратили, сколько заработали и что заплатите скоро. Все цифры считаются на вашем устройстве.",
  },
  {
    title: "Запись за пару секунд",
    text: "Нажмите «+» и введите сумму. Категория подставится сама, дату можно поменять. Повторные траты создают шаблон.",
  },
  {
    title: "Платы и цели",
    text: "Регулярные платежи превращаются в напоминания, а цели показывают, сколько осталось накопить. Отметка «пропущено» переносит платёж на потом.",
  },
  {
    title: "Резервная копия",
    text: "Раз в пару недель выгружайте файл в настройках. Если что-то пойдёт не так, данные вернутся из файла за минуту.",
  },
];

export function Onboarding() {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const storage = await getStorage();
        const done = await storage.getFlag(ONBOARDING_FLAG);
        if (!cancelled && !done) setOpen(true);
      } catch {
        /* при ошибке хранилища онбординг просто не показываем */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const finish = useCallback(async () => {
    setOpen(false);
    try {
      const storage = await getStorage();
      await storage.setFlag(ONBOARDING_FLAG, new Date().toISOString());
    } catch {
      /* флаг не критичен */
    }
  }, []);

  const next = useCallback(() => {
    if (index >= STEPS.length - 1) void finish();
    else setIndex((i) => i + 1);
  }, [index, finish]);

  /**
   * Аппаратная кнопка «Назад». Онбординг — не Modal, поэтому регистрируется
   * вручную; «Назад» здесь равносилен кнопке «Пропустить»: экрана под панелью
   * не видно, а выпустить нажатие в систему (пользователь ушёл бы из
   * приложения, не начав им пользоваться) хуже. Флаг при этом пишется, поэтому
   * второй раз панель не покажется.
   */
  useOverlay(open, finish);

  if (!open) return null;
  const step = STEPS[index];
  const isLast = index === STEPS.length - 1;

  return (
    <div
      className="modal-overlay fixed inset-0 z-[90] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Знакомство с приложением"
    >
      <FocusTrap active>
        <div className="card onboarding-panel w-full max-w-md p-6 flex flex-col gap-5">
          <div className="flex items-center gap-3">
            <span className="hex flex items-center justify-center" style={{ width: 40, height: 40, color: "var(--accent)" }} aria-hidden>
              <Wallet size={18} strokeWidth={1.8} />
            </span>
            <div>
              <p className="text-[11px] font-semibold tracking-[0.22em] uppercase" style={{ color: "var(--accent)" }}>
                Шаг {index + 1} из {STEPS.length}
              </p>
              <h2 className="font-display text-lg font-bold uppercase" style={{ color: "var(--text)" }}>
                {step.title}
              </h2>
            </div>
          </div>

          <p className="text-sm leading-relaxed" style={{ color: "var(--muted)" }}>{step.text}</p>

          <div className="flex items-center gap-1.5" aria-hidden>
            {STEPS.map((s, i) => (
              <span
                key={s.title}
                className={cn("dot", i === index && "opacity-100")}
                style={{ opacity: i === index ? 1 : 0.28 }}
              />
            ))}
          </div>

          <div className="flex items-center gap-2.5">
            <button className="btn btn-ghost" onClick={() => void finish()}>Пропустить</button>
            <button className="btn btn-primary flex items-center gap-1.5 ml-auto" onClick={next}>
              {isLast ? <Check size={15} /> : <ArrowRight size={15} />}
              {isLast ? "Начать" : "Далее"}
            </button>
          </div>
        </div>
      </FocusTrap>
    </div>
  );
}
