// src/main.dev.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { DevTools } from "./components/DevTools"; // 🔥 Импортируем DevTools

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <DevTools /> {/* 🔥 Добавляем DevTools только для разработчика */}
  </StrictMode>
);