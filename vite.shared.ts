// vite.shared.ts
// Общие настройки сборки для прод- и dev-конфигов.
//
// wasmInlinePlugin нужен для SQLite (sql.js). Стандартный «?inline» не подходит:
// Vite помечает импорт ресурса как модуль («?import») и пытается разобрать
// бинарный .wasm как JavaScript — dev-сервер отвечает 500.
// Плагин отдаёт .wasm как JS-модуль с base64 data-URL: такой вариант работает
// в dev, в single-file сборке и по протоколу file:// (Electron).
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

export const WASM_INLINE_QUERY = "wasm-inline";

export const wasmInlinePlugin = (): Plugin => ({
  name: "nexus:wasm-inline",
  enforce: "pre",
  async resolveId(id, importer) {
    const [file, query] = id.split("?");
    if (!query || !query.split("&").includes(WASM_INLINE_QUERY)) return null;
    const resolved = await this.resolve(file, importer, { skipSelf: true });
    return resolved ? `${resolved.id}?${WASM_INLINE_QUERY}` : null;
  },
  load(id) {
    const [file, query] = id.split("?");
    if (query !== WASM_INLINE_QUERY) return null;
    try {
      const base64 = readFileSync(file).toString("base64");
      return `export default "data:application/wasm;base64,${base64}";`;
    } catch (err) {
      this.error(`Не удалось встроить WASM-ресурс ${file}: ${(err as Error).message}`);
      return null;
    }
  },
});
