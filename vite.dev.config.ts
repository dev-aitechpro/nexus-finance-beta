import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { wasmInlinePlugin } from "./vite.shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  plugins: [wasmInlinePlugin(), react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  define: {
    'process.env': {},
    'global': 'globalThis',
  },
  optimizeDeps: {
    exclude: ['electron', 'fs', 'path', 'child_process'],
  },
  build: {
    rollupOptions: {
      // См. пояснение в vite.config.ts: external для node-модулей ломает
      // браузерную сборку (голый import "fs" не резолвится в браузере).
      // 🔥 В режиме разработки используем main.dev.tsx (с DevTools)
      input: {
        main: path.resolve(__dirname, 'index.dev.html'),
      },
    },
  },
});