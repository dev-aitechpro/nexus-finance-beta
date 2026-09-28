// src/storage/wasmAsset.ts
// Статический импорт WASM-ресурса намеренно вынесен в отдельный модуль.
//
// Почему так: при динамическом импорте самого .wasm Vite добавляет к URL
//query «?import» и пытается разобрать бинарник как JavaScript — dev-сервер
// отвечает 500 («content contains invalid JS syntax»). Статический импорт
// с суффиксом «?inline» кодирует файл в base64 data-URL, поэтому он
// работает и в dev, и в single-file сборке, и по протоколу file:// (Electron).
import wasmInline from "sql.js/dist/sql-wasm.wasm?wasm-inline";

/** Содержимое sql-wasm.wasm в виде base64 data-URL. */
export default wasmInline;
