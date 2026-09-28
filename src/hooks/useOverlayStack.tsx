// src/hooks/useOverlayStack.tsx
// Стек открытых оверлеев: верхний из них закрывает аппаратная кнопка «Назад».
//
// Зачем это отдельным слоем, а не флагом в каждом диалоге: подписаться на
// backButton второй раз нельзя. Capacitor раздаёт одно нативное событие ВСЕМ
// подписчикам (notifyListeners перебирает список), а мост после вызова смотрит
// на результат — вернувший false зовёт passBackToSystem → App.exitApp. Значит
// обработчик в приложении ровно один (usePlatformBackButton в src/App.tsx), и
// он сам должен решить, КОМУ из открытых диалогов нажатие достанется. Порядок
// открытия — единственное правило выбора: последний открытый закрывается
// первым, как в браузере и как в самом Android.
//
// Стек общий для всех диалогов приложения, поэтому живёт в контексте рядом с
// AppProvider и переживает смену вкладок: открытая модалка на «Платежах»
// остаётся в стеке, пока открыта, и «Назад» её закрывает.
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";

/**
 * Закрывалка верхнего оверлея. Ничего не возвращает: «обработано ли нажатие»
 * решает вызывающий (цепочка в App.tsx) — нажатие считается обработанным даже
 * тогда, когда диалог не закрылся, а лишь задал вопрос.
 */
export type OverlayCloser = () => void;

export interface OverlayStackValue {
  /** Положить закрывалку в стек. Возвращает отписку (звать дважды безвредно). */
  push: (closer: OverlayCloser) => () => void;
  /** Последний открытый оверлей или null, если открытых нет. */
  top: () => OverlayCloser | null;
}

/**
 * Запись стека. Объект, а не сама функция: снимать надо именно эту подписку, а
 * не «первую такую же функцию» — два диалога вправе передать один и тот же
 * onClose (например, общий обработчик из родителя).
 */
interface StackEntry {
  closer: OverlayCloser;
}

/**
 * Действия и версия разнесены по ДВУМ контекстам — намеренно, и это не
 * перестраховка:
 *
 *   * `useOverlayStack()` (действия) читает App.tsx — ради `top()` в обработчике
 *     «назад». Значение контекста здесь постоянно, поэтому открытие или
 *     закрытие диалога НЕ перерисовывает приложение. Иначе получился бы цикл:
 *     версия меняется → перерисовка корня → экран, который объявляет диалог
 *     внутри своего рендера (Payments → «Подтвердить»: ConfirmModalComponent и
 *     SkipModalComponent создаются на каждом рендере), пересоздаёт тип
 *     компонента → React перемонтирует открытый Modal → регистрация слетает и
 *     кладётся заново → версия меняется ещё раз… бесконечный цикл.
 *   * Версия живёт отдельно и достаётся хуком useOverlayVersion() — только
 *     тому, кому действительно нужно перерисоваться по факту открытия
 *     оверлея. Сегодня таких потребителей в приложении нет: цепочка «назад»
 *     читает top() лениво, в момент нажатия.
 */
const StackActionsContext = createContext<OverlayStackValue | null>(null);
const StackVersionContext = createContext<number>(0);

export function OverlayStackProvider({ children }: { children: ReactNode }) {
  /**
   * Список — в useRef, а не в useState, и это не микрооптимизация:
   *
   *   1) порядок важен, а решение принимается ОДИН раз — на нажатии. «Последнего
   *      открытого» из useState не получить: пришлось бы тянуть зависимости в
   *      App.tsx, а смена идентичности зависимостей означала бы переподписку на
   *      нативное событие (ровно тот баг, из-за которого обработчик держится в
   *      ref, см. usePlatformBackButton);
   *   2) обработчик «назад» должен увидеть список на момент нажатия, а не
   *      снимок на момент рендера. С useState такой снимок протухает: подписчик
   *      поймал бы старый массив и закрыл не тот диалог — тот, что к моменту
   *      нажатия уже закрыли;
   *   3) ref не участвует в сравнении зависимостей, поэтому сам список не может
   *      переподписать ни стек, ни нативного слушателя.
   */
  const stackRef = useRef<StackEntry[]>([]);
  /**
   * Версия — единственная изменяемая часть, видимая React. Список в ref,
   * поэтому без неё потребитель версии не узнал бы об изменениях. Значение
   * отдаётся отдельным контекстом: нажать «Назад» или открыть окно не должно
   * перерисовывать всё приложение (см. комментарий над контекстами).
   */
  const [version, setVersion] = useState(0);
  const bump = useCallback((): void => setVersion((v) => v + 1), []);

  const push = useCallback((closer: OverlayCloser): (() => void) => {
    const entry: StackEntry = { closer };
    stackRef.current.push(entry);
    bump();
    let released = false;
    return (): void => {
      // Отписку зовут и cleanup-эффекты, и StrictMode (он дважды прогоняет
      // эффекты), поэтому она обязана быть идемпотентной: второй вызов не
      // должен снести из стека чужой оверлей с той же закрывалкой.
      if (released) return;
      released = true;
      const i = stackRef.current.indexOf(entry);
      if (i < 0) return; // уже снят — закрывать больше нечего
      stackRef.current.splice(i, 1);
      bump();
    };
  }, [bump]);

  const top = useCallback(
    (): OverlayCloser | null => stackRef.current[stackRef.current.length - 1]?.closer ?? null,
    [],
  );

  // Идентичность стабильна: push/top завязаны на useCallback с неизменными
  // зависимостях, поэтому значение меняется только вместе с самим провайдером.
  const actions = useMemo<OverlayStackValue>(() => ({ push, top }), [push, top]);

  return (
    <StackActionsContext.Provider value={actions}>
      <StackVersionContext.Provider value={version}>{children}</StackVersionContext.Provider>
    </StackActionsContext.Provider>
  );
}

/** Стек оверлеев. Вне провайдера — ошибка: «Назад» просто не увидит диалоги. */
export function useOverlayStack(): OverlayStackValue {
  const ctx = useContext(StackActionsContext);
  if (!ctx) throw new Error("useOverlayStack must be used within OverlayStackProvider");
  return ctx;
}

/**
 * Сколько раз стек менялся. Компонент, который берёт это значение, перерисовывается
 * при каждом открытии и закрытии оверлея; цепочке «назад» он не нужен (см.
 * useOverlayStack). Пользоваться стоит только там, где перерисовка уместна.
 */
export function useOverlayVersion(): number {
  return useContext(StackVersionContext);
}

/**
 * Сообщить стеку про свой оверлей, пока `active` истинно.
 *
 * Закрывалку хук читает через ref, поэтому её смена (у Modal `onClose` — новая
 * стрелка на каждом рендере) НЕ переподписывает стек: подписка появляется и
 * снимается только по `active`. Это и есть причина, по которой стек не залипает:
 * запись живёт ровно между двумя эффектами и снимается тем же cleanup-ом, что и
 * подписка на нативное событие.
 *
 * Порядок в стеке — это порядок эффектов: React собирает их снизу вверх,
 * поэтому при первом монтировании родитель встаёт в стек после детей. На
 * вложенные диалоги это не влияет: ребёнок регистрируется не при монтировании,
 * а в момент открытия, то есть всегда позже родителя, и открытый диалог
 * оказывается сверху.
 */
export function useOverlay(active: boolean, closer: OverlayCloser): void {
  const { push } = useOverlayStack();
  // Актуальная закрывалка обновляется на каждом рендере (тот же приём, что у
  // Modal с capsRef и у ToastHost с itemsRef).
  const closerRef = useRef(closer);
  closerRef.current = closer;
  useEffect(() => {
    if (!active) return;
    return push(() => closerRef.current());
  }, [active, push]);
}
