/// <reference types="vite/client" />
// src/components/DevTools.tsx
import { useState } from "react";
import { Code2, X, Database, RefreshCw, AlertTriangle } from "lucide-react";
import { useApp } from "../hooks/AppProvider";

// 🔥 Ключ теперь загружается из .env (не попадает в Git!)
const DEV_ACCESS_KEY = import.meta.env.VITE_DEV_ACCESS_KEY || null;

export function DevTools() {
  const { data, loadDemo, clearAll, exportNow, notify } = useApp();
  const [isOpen, setIsOpen] = useState(false);
  const [accessKey, setAccessKey] = useState("");
  const [isAuthorized, setIsAuthorized] = useState(false);

  // Если ключ не задан в .env — DevTools полностью отключены
  if (!DEV_ACCESS_KEY) return null;

  const handleAccess = () => {
    if (accessKey === DEV_ACCESS_KEY) {
      setIsAuthorized(true);
      setIsOpen(true);
      notify("🔧 Инструменты разработчика открыты");
    } else {
      notify("❌ Неверный ключ доступа", "error");
    }
  };

  if (!isOpen && !isAuthorized) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50">
      <button
        className="btn btn-ghost btn-sm"
        onClick={() => {
          if (isAuthorized) {
            setIsOpen(!isOpen);
          } else {
            setIsOpen(true);
          }
        }}
        title="Инструменты разработчика"
      >
        <Code2 size={16} />
      </button>

      {isOpen && (
        <div className="absolute bottom-12 left-0 w-80 p-4 card rise-in" style={{ background: "var(--card-solid)" }}>
          <div className="flex items-center justify-between mb-3">
            <h4 className="font-display text-sm uppercase tracking-wider" style={{ color: "var(--accent)" }}>
              <Code2 size={14} className="inline mr-2" />
              Dev Tools
            </h4>
            <button className="btn-icon" onClick={() => setIsOpen(false)}>
              <X size={14} />
            </button>
          </div>

          {!isAuthorized ? (
            <div className="space-y-3">
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                Введите ключ доступа для открытия инструментов разработчика.
              </p>
              <div className="flex gap-2">
                <input
                  className="input mono text-sm flex-1"
                  type="password"
                  placeholder="Ключ доступа"
                  value={accessKey}
                  onChange={(e) => setAccessKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAccess();
                  }}
                />
                <button className="btn btn-primary btn-sm" onClick={handleAccess}>
                  Войти
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <button className="btn btn-ghost btn-sm w-full justify-start" onClick={() => loadDemo()}>
                <RefreshCw size={14} className="mr-2" /> Загрузить демо-данные
              </button>
              <button className="btn btn-ghost btn-sm w-full justify-start" onClick={() => exportNow()}>
                <Database size={14} className="mr-2" /> Экспортировать данные
              </button>
              <button className="btn btn-ghost btn-sm w-full justify-start" onClick={() => { if (confirm("Вы уверены?")) clearAll(); }} style={{ color: "var(--danger)" }}>
                <AlertTriangle size={14} className="mr-2" /> Очистить все данные
              </button>
              <div className="mt-3 pt-3 border-t" style={{ borderColor: "var(--line)" }}>
                <p className="text-xs" style={{ color: "var(--muted)" }}>Всего транзакций: {data.transactions.length}</p>
                <p className="text-xs" style={{ color: "var(--muted)" }}>Версия: {import.meta.env.VITE_APP_VERSION || "1.0.0"}</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}