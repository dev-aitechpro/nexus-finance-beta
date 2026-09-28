// src/hooks/usePlatformBackButton.ts
// Аппаратная кнопка «Назад» (Android) обрабатывается через PlatformBridge,
// чтобы логика «назад» жила в одном месте и не зависела от платформы.
// Показывается: «Назад» закрывает открытую модалку транзакции, иначе возвращает
// на главный экран. На главном экране обработчик возвращает false — систему
// выпускают из приложения (мост при этом не перехватывает событие).
import { useEffect, useRef } from "react";
import { platform } from "../platform";

export const usePlatformBackButton = (
  canHandle: () => boolean,
  onBack: () => void,
): void => {
  // Актуальные canHandle/onBack держим в ref, а подписку делаем один раз.
  // В App.tsx обе функции — инлайновые стрелки, то есть новые на каждом
  // рендере; с ними в зависимостях эффект переподписывался бы на каждом
  // рендере, а подписка на стороне контейнера — асинхронный round-trip к
  // нативному слою (плюс окно, когда отписаться ещё нечем).
  const latest = useRef({ canHandle, onBack });
  useEffect(() => {
    latest.current = { canHandle, onBack };
  });

  useEffect(() => {
    const bridge = platform();
    if (!bridge.features.backButton) return;
    return bridge.onBackButton(() => {
      const current = latest.current;
      if (!current.canHandle()) return false;
      current.onBack();
      return true;
    });
  }, []);
};
