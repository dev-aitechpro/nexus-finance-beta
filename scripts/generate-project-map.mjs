#!/usr/bin/env node
// scripts/generate-project-map.mjs
// Генератор карты проекта (ТЗ п. 6).
//
// Задача: дать агенту/разработчику компактное описание репозитория —
// что где лежит, какой у модуля слой, ключевые экспорты, кто кого импортирует
// и как текут данные — вместо чтения всего кода.
//
// Структура project-map.json повторяет схему из ТЗ:
//   modules/    — список модулей: назначение, exports, depends-on, used-by
//   symbols/    — индекс ключевых символов: имя -> { file, line, type }
//   data-flow/  — потоки данных: именованные цепочки + рёбра импортов
//   files/      — плоский список файлов с размерами (для точечного чтения)
//
// Ручные описания берутся из map.config.ts, фактические размеры, символы и
// рёбра импортов сканируются с диска, поэтому карта не устаревает молча:
// после `npm run map` видно, какие файлы и связи добавились.
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const loadConfig = async () => {
  const configPath = path.join(root, "map.config.ts");
  const url = pathToFileURL(configPath).href;
  // Node 23+ умеет импортировать TypeScript напрямую (снятие типов).
  const { default: config } = await import(url);
  return config;
};

const LAYER_BY_DIR = {
  storage: "storage",
  animations: "state",
  platform: "platform",
  components: "ui",
  views: "ui",
  hooks: "state",
  lib: "domain",
  utils: "ui",
  tests: "test",
  scripts: "infra",
  docs: "infra",
};

const layerOf = (file, modulesByPath) => {
  const described = modulesByPath.get(file);
  if (described) return described.layer;
  const [top] = file.split("/");
  return LAYER_BY_DIR[top] ?? "infra";
};

const isIgnored = (relative, ignore) =>
  ignore.some((pattern) => {
    if (pattern.startsWith("*.")) return relative.endsWith(pattern.slice(1));
    return relative === pattern || relative.startsWith(`${pattern}/`) || relative.includes(`/${pattern}/`);
  });

// ───────────────────────── разбор исходников ─────────────────────────

/** Виды экспортов, которые нас интересуют (по ТЗ: type: "interface" / "function" / ...). */
const EXPORT_PATTERNS = [
  { re: /^export\s+(?:declare\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/, type: "function" },
  { re: /^export\s+(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/, type: "class" },
  { re: /^export\s+interface\s+([A-Za-z0-9_$]+)/, type: "interface" },
  { re: /^export\s+type\s+([A-Za-z0-9_$]+)/, type: "type" },
  { re: /^export\s+(?:const\s+)?enum\s+([A-Za-z0-9_$]+)/, type: "enum" },
];

/**
 * Извлекает экспортируемые символы с номерами строк.
 * Возвращает Map<name, { file, line, type }>.
 */
const extractExports = (source, file) => {
  const found = new Map();
  const lines = source.split("\n");

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line.startsWith("export")) return;
    const lineNo = index + 1;

    for (const { re, type } of EXPORT_PATTERNS) {
      const match = line.match(re);
      if (match) {
        if (!found.has(match[1])) found.set(match[1], { file, line: lineNo, type });
        return;
      }
    }

    const asConst = line.match(/^export\s+(?:const\s+|let\s+|var\s+)([A-Za-z0-9_$]+)/);
    if (asConst) {
      // Стрелочная функция определяется по инициализатору — для карты это важно:
      // вызов идёт как функция, а не как значение.
      const tail = lines.slice(index, index + 3).join(" ");
      const type = /=(\s*)?(async\s*)?(\(|function\b)/.test(tail) ? "function" : "const";
      if (!found.has(asConst[1])) found.set(asConst[1], { file, line: lineNo, type });
      return;
    }

    const named = line.match(/^export\s*\{([^}]*)\}/);
    if (named) {
      for (const part of named[1].split(",")) {
        const name = part.split(/\s+as\s+/).pop()?.trim();
        if (!name) continue;
        if (!found.has(name)) found.set(name, { file, line: lineNo, type: "re-export" });
      }
      return;
    }

    if (/^export\s+\*\s+from/.test(line) || /^export\s*\{/.test(line)) {
      if (!found.has("*")) found.set("*", { file, line: lineNo, type: "re-export" });
      return;
    }

    if (/^export\s+default/.test(line) && !found.has("default")) {
      const name = line.match(/^export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z0-9_$]+)/);
      found.set("default", { file, line: lineNo, type: name ? "default" : "default-value" });
    }
  });

  return found;
};

const IMPORT_RE = /(?:^|\s)(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|(?:^|\s)import\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Спецификаторы локальных модулей (относительные и алиас @/) с учётом расширений. */
const extractLocalImports = (source, fromFile) => {
  const dir = path.posix.dirname(fromFile);
  const specs = new Set();
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (!spec) continue;
    const resolved = spec.startsWith("@/")
      ? path.posix.normalize(`src/${spec.slice(2)}`)
      : spec.startsWith(".")
        ? path.posix.normalize(path.posix.join(dir, spec))
        : null; // внешний пакет — в карте не показываем
    if (!resolved) continue;
    for (const candidate of [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}/index.ts`]) {
      if (knownFiles.has(candidate)) {
        specs.add(candidate);
        break;
      }
    }
  }
  return [...specs];
};

/** Область (верхний каталог) файла — для агрегированных рёбер. */
const areaOf = (file) => file.split("/").slice(0, 2).join("/");

// ───────────────────────── обход файлов ─────────────────────────

const walk = async (dir, ignore, out = []) => {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (isIgnored(relative, ignore)) continue;
    if (entry.isDirectory()) {
      await walk(absolute, ignore, out);
      continue;
    }
    if (!/\.(ts|tsx|cjs|mjs|js|jsx|html|css|md|json)$/.test(entry.name)) continue;
    const info = await stat(absolute);
    const source = await readFile(absolute, "utf8");
    out.push({ path: relative, bytes: info.size, lines: source.split("\n").length, source });
  }
  return out;
};

const knownFiles = new Set();

const main = async () => {
  const config = await loadConfig();
  const modulesByPath = new Map(config.modules.map((m) => [m.path, m]));

  const files = [];
  for (const area of config.areas) {
    const absolute = path.join(root, area.path);
    try {
      await stat(absolute);
    } catch {
      continue;
    }
    files.push(...(await walk(absolute, config.ignore, [])));
  }

  // Файлы вне описанных областей (точки входа, конфиги) — компактно, без исходника.
  for (const entry of config.entryPoints) {
    try {
      const absolute = path.join(root, entry);
      const info = await stat(absolute);
      const source = /\.(ts|tsx|cjs|mjs|js)$/.test(entry) ? await readFile(absolute, "utf8") : "";
      files.push({
        path: entry,
        bytes: info.size,
        lines: source ? source.split("\n").length : 0,
        source,
      });
    } catch {
      /* файл может отсутствовать (например, index.dev.html) */
    }
  }

  for (const file of files) knownFiles.add(file.path);

  // Индекс символов и рёбра импортов.
  // Символы собираются в два прохода: сначала определения, потом реэкспорты —
  // иначе `migrateLegacyData` указывал бы на файл, который его перепродаёт.
  const definitions = {};
  const reExports = {};
  const importsByFile = new Map();
  for (const file of files) {
    if (!file.source || /\.(css|html|md|json)$/.test(file.path)) continue;
    for (const [name, location] of extractExports(file.source, file.path)) {
      const bucket = location.type === "re-export" ? reExports : definitions;
      if (!bucket[name]) bucket[name] = location;
    }
    importsByFile.set(file.path, extractLocalImports(file.source, file.path));
  }
  // Слияние реэкспортов и определений. Само по себе слияние безопасно:
  // в JavaScript ключи регистрозависимы. Но в JSON имена, различающиеся
  // только регистром (обычная пара «функция + одноимённый тип»: storageInfo
  // и StorageInfo, pendingKind и PendingKind), выглядят как дубли ключей, и
  // потребители, нечувствительные к регистру, на этом падают — например
  // ConvertFrom-Json в PowerShell. Такие имена разводим суффиксом вида
  // символа; остальные ключи не трогаем.
  const merged = { ...reExports, ...definitions };
  const symbols = {};
  for (const [name, location] of Object.entries(merged)) {
    const clash = Object.keys(symbols).some((key) => key.toLowerCase() === name.toLowerCase());
    symbols[clash ? `${name}#${location.type ?? "symbol"}` : name] = location;
  }

  const usedBy = new Map();
  for (const [file, imports] of importsByFile) {
    for (const target of imports) {
      if (!usedBy.has(target)) usedBy.set(target, new Set());
      usedBy.get(target).add(file);
    }
  }

  const shortList = (list = [], limit = 8) => [...list].sort().slice(0, limit);

  const modules = config.modules.map((m) => {
    const found = files.find((f) => f.path === m.path);
    // Список экспортов берём из merged, а не из symbols: в symbols ключи
    // дублей дополнены суффиксом, и в списке экспортов модуля он был бы лишним.
    const autoExports = Object.keys(merged)
      .filter((name) => merged[name].file === m.path)
      .sort();
    return {
      path: m.path,
      title: m.title,
      summary: m.summary,
      layer: m.layer,
      exports: m.exports ?? shortList(autoExports),
      "depends-on": shortList(importsByFile.get(m.path) ?? []),
      "used-by": shortList([...(usedBy.get(m.path) ?? [])]),
      lines: found?.lines ?? 0,
      missing: !found,
    };
  });

  // Рёбра импортов: файловые (для точечного чтения) и агрегированные по областям.
  const edgeCount = new Map();
  for (const [file, imports] of importsByFile) {
    for (const target of imports) edgeCount.set(`${file}|${target}`, (edgeCount.get(`${file}|${target}`) ?? 0) + 1);
  }
  const edges = [...edgeCount.entries()]
    .map(([key, imports]) => {
      const [from, to] = key.split("|");
      return { from, to, imports };
    })
    .sort((a, b) => b.imports - a.imports || a.from.localeCompare(b.from));

  const areaEdges = new Map();
  for (const edge of edges) {
    const from = areaOf(edge.from);
    const to = areaOf(edge.to);
    if (from === to) continue;
    const key = `${from}|${to}`;
    areaEdges.set(key, (areaEdges.get(key) ?? 0) + edge.imports);
  }

  const files_ = files
    .map(({ source, ...rest }) => ({
      ...rest,
      layer: layerOf(rest.path, modulesByPath),
      "depends-on": shortList(importsByFile.get(rest.path) ?? [], 6),
    }))
    .sort((a, b) => b.lines - a.lines);

  const byLayer = {};
  for (const file of files_) byLayer[file.layer] = (byLayer[file.layer] ?? 0) + 1;

  const missing = modules.filter((m) => m.missing).map((m) => m.path);
  const undocumented = files_
    .filter((f) => !modulesByPath.has(f.path) && f.layer === "infra" && !config.entryPoints.includes(f.path))
    .map((f) => f.path);

  const map = {
    name: "NEXUS Finance",
    generatedAt: new Date().toISOString(),
    note: "Сгенерировано командой «npm run map». Ручные описания правьте в map.config.ts.",
    entryPoints: config.entryPoints,
    areas: config.areas,
    layers: byLayer,
    stats: {
      files: files_.length,
      lines: files_.reduce((sum, f) => sum + f.lines, 0),
      documentedModules: modules.length,
      symbols: Object.keys(symbols).length,
      importEdges: edges.length,
    },
    modules,
    symbols: Object.fromEntries(Object.entries(symbols).sort(([a], [b]) => a.localeCompare(b))),
    "data-flow": {
      flows: config.dataFlows ?? [],
      byArea: [...areaEdges.entries()]
        .map(([key, weight]) => {
          const [from, to] = key.split("|");
          return { from, to, weight };
        })
        .sort((a, b) => b.weight - a.weight),
      edges: edges.slice(0, 200),
    },
    "task-history": {
      note: "Заполняется вручную в map.config.ts (поле taskHistory) по мере крупных задач.",
      items: config.taskHistory ?? [],
    },
    files: files_,
    issues: { missingModules: missing, undocumented: undocumented.slice(0, 40) },
  };

  const outFile = path.join(root, config.outFile);
  await writeFile(outFile, `${JSON.stringify(map, null, 2)}\n`, "utf8");

  console.log(`Карта проекта: ${config.outFile}`);
  console.log(
    `  файлов: ${map.stats.files}, строк: ${map.stats.lines}, символов: ${map.stats.symbols}, рёбер: ${map.stats.importEdges}`,
  );
  console.log(`  модулей описано: ${map.stats.documentedModules}`);
  if (missing.length) console.warn(`  ! нет файла для модулей: ${missing.join(", ")}`);
  if (undocumented.length) console.log(`  без описания: ${undocumented.length}`);
};

await main();
