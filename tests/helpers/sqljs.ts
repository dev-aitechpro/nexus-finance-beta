// tests/helpers/sqljs.ts
// Загрузчик sql.js для Node: WASM читается с диска, без HTTP и file://.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { SqlJsLoader } from "../../src/storage/sqlite";

const require = createRequire(import.meta.url);
const distDir = path.dirname(require.resolve("sql.js/dist/sql-wasm.js"));

export const nodeSqlJsLoader: SqlJsLoader = async (config) => {
  const initSqlJs = (await import("sql.js/dist/sql-wasm.js")).default;
  const wasmBinary = readFileSync(path.join(distDir, "sql-wasm.wasm"));
  return initSqlJs({ ...config, wasmBinary });
};
