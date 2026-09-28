// src/storage/sqljs.d.ts
// Типы для прямых импортов дистрибутива sql.js и WASM-ресурса.
// WASM встраивается инлайном (?inline → data URL), поэтому работает
// и в dev-сервере, и в single-file сборке, и по протоколу file:// (Electron).
declare module "sql.js/dist/sql-wasm.js" {
  const initSqlJs: (config?: Record<string, unknown>) => Promise<import("sql.js").SqlJsStatic>;
  export default initSqlJs;
}

declare module "sql.js/dist/sql-asm.js" {
  const initSqlJs: (config?: Record<string, unknown>) => Promise<import("sql.js").SqlJsStatic>;
  export default initSqlJs;
}

declare module "*.wasm?inline" {
  const dataUrl: string;
  export default dataUrl;
}

declare module "*.wasm?wasm-inline" {
  const dataUrl: string;
  export default dataUrl;
}

declare module "*.wasm?url" {
  const url: string;
  export default url;
}
