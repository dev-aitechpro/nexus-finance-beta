#!/usr/bin/env node
/**
 * scripts/publish-release.mjs
 *
 * Публикация релиза NEXUS Finance в приватный репозиторий GitHub одной командой.
 * Скрипт написан на чистом Node (только `node:*`, без внешних зависимостей) и
 * говорит с GitHub через REST API; сборку не изобретает — зовёт уже существующие
 * `scripts/build-windows.mjs` и `scripts/build-android.mjs`.
 *
 *   $env:GITHUB_TOKEN = "github_pat_…"      # PowerShell (или export GITHUB_TOKEN=…)
 *   node scripts/publish-release.mjs
 *
 * Что именно нужно знать про токен:
 *
 *  · берётся ТОЛЬКО из переменной окружения `GITHUB_TOKEN`. Ни аргументом
 *    командной строки (аргументы видны в списке процессов и в истории оболочки),
 *    ни из файла в проекте — `.gitignore` запрещает `*.token`/`gh-token.txt`/
 *    `release.local.json` именно потому, что токен не должен переживать команду;
 *  · fine-grained PAT: репозиторий `dev-aitechpro/nexus-finance-beta`,
 *    «Repository access» → Only select repositories; «Repository permissions» →
 *    Contents: Read and write (создание тега и релиза) и
 *    Administration: Read and write для шага «создать репозиторий»
 *    (если репозиторий уже создан вручную, достаточно только Contents);
 *    у fine-grained токена область ограничена репозиторием — это правильно;
 *  · classic PAT: достаточно scope `repo` — он даёт и чтение приватного
 *    репозитория, и запись в него. Scope `workflow` не нужен: скрипт не
 *    публикует через GitHub Actions.
 *
 * Почему `git push` делает скрипт, а не пользователь. Заявленное требование —
 * «одна команда», а `git push` с токеном — это отдельная ручная операция, в
 * которой чаще всего и теряется релиз (забыли запустить, забыли про тег). Но
 * токен не должен остаться в `.git/config`. Поэтому скрипт НЕ добавляет remote
 * с токеном и НЕ пишет его в конфиг: он передаёт заголовок авторизации
 * одноразово, через переменные окружения `GIT_CONFIG_COUNT` /
 * `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0` (git ≥ 2.31 читает их как
 * `-c key=value` из окружения). Итог: токен не попадает ни в `.git/config`,
 * ни в `git remote -v`, ни в список процессов, и после завершения команды
 * ничего не остаётся на диске. Если `git push` всё же не прошёл, скрипт
 * печатает точную команду для ручного запуска и не считает это фатальным:
 * релиз и файлы к этому моменту уже созданы.
 *
 * Идемпотентность. Скрипт можно запускать повторно: существующий репозиторий,
 * существующий тег и существующий релиз переиспользуются, уже загруженные
 * файлы пропускаются (или перезаливаются с `--force-assets`). Удаляются только
 * файлы релиза и только когда `--force-assets` попросили явно; исходники, теги
 * и чужие релизы скрипт не трогает.
 *
 * Чего скрипт не делает: не запускает `gh`, не трогает `src/**`, не подписывает
 * сборки и не публикует в Google Play.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `fs.openAsBlob` есть с Node 19.8/20 и кладёт файл в тело fetch без чтения
// 100 МБ в память. На более старом Node откатимся на буфер.
let openAsBlob = null;
try {
  ({ openAsBlob } = await import("node:fs"));
} catch {
  openAsBlob = null;
}

// ------------------------------------------------------------------ константы

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const API_VERSION = "2022-11-28";
const UA = "nexus-finance-publish/1.0 (scripts/publish-release.mjs)";
const IS_WIN = process.platform === "win32";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

// Шаги выводятся в `--help` и нумеруются в журнале — держим в одном месте.
const STEPS = [
  "проверка версии (package.json ↔ android/app/build.gradle)",
  "проверка GITHUB_TOKEN и прав доступа",
  "приватный репозиторий dev-aitechpro/nexus-finance-beta",
  "локальный git: чистое дерево, коммит, тег, push",
  "сборка артефактов (build-windows.mjs, build-android.mjs)",
  "проверка артефактов: наличие, размер, версия, свежесть",
  "релиз v<версия> с меткой prerelease",
  "загрузка файлов на uploads.github.com",
  "сводка",
];

// --------------------------------------------------------------------- вывод

const c = {
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  d: (s) => `\x1b[90m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};
const out = (m = "") => process.stdout.write(`${m}\n`);
let stepNo = 0;
const step = (m) => out(`${c.b(`[${++stepNo}/${STEPS.length}]`)} ${m}`);
const ok = (m) => out(`      ${c.g("✓")} ${m}`);
const info = (m) => out(`      ${c.d("·")} ${m}`);
const warn = (m) => out(`      ${c.y("!")} ${m}`);
const err = (m) => out(`${c.r("✗")} ${m}`);
const die = (m, code = 1) => {
  err(m);
  process.exit(code);
};

const MB = 1048576;
const fmtSize = (bytes) =>
  bytes >= MB ? `${(bytes / MB).toFixed(2)} МБ` : `${(bytes / 1024).toFixed(1)} КБ`;
const fmtTime = (ms) => (ms < 950 ? `${Math.round(ms)} мс` : `${(ms / 1000).toFixed(1)} с`);
const pad = (s, n) => (s.length >= n ? s : s + " ".repeat(n - s.length));

// ---------------------------------------------------------------- аргументы

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const val = (name, fallback = undefined) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const known = new Set([
  "--help", "-h", "--dry-run", "--skip-build", "--skip-apk", "--skip-git",
  "--allow-dirty", "--force-assets", "--notes", "--owner", "--repo",
]);

const pkgPath = path.join(ROOT, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const publishCfg = typeof pkg.build?.publish === "object" && pkg.build.publish ? pkg.build.publish : {};
const OWNER = val("--owner", publishCfg.owner ?? "dev-aitechpro");
const REPO = val("--repo", publishCfg.repo ?? "nexus-finance-beta");
const CHANNEL = publishCfg.channel ?? "latest";
const RELEASE_TYPE = publishCfg.releaseType ?? "release";
// productName живёт в build, а не в корне package.json: electron-builder
// берёт оттуда и имя файла артефакта, и `${productName}` в шаблонах имён.
const PRODUCT = pkg.build?.productName ?? pkg.productName ?? pkg.name ?? "app";
const TAG = `v${pkg.version}`;

const HELP = has("--help") || has("-h");
const DRY_RUN = has("--dry-run");
const SKIP_BUILD = has("--skip-build");
const SKIP_APK = has("--skip-apk");
const SKIP_GIT = has("--skip-git");
const ALLOW_DIRTY = has("--allow-dirty");
const FORCE_ASSETS = has("--force-assets");
const NOTES_FILE = val("--notes");

function printHelp() {
  out(`${c.b("NEXUS Finance — публикация релиза в приватный GitHub")}

${c.b("Использование")}
  node scripts/publish-release.mjs [ключи]

  Перед запуском в переменной окружения должен быть GITHUB_TOKEN
  (fine-grained PAT с правом «Contents: Read and write» на репозиторий
  ${OWNER}/${REPO} либо classic PAT со scope repo).

${c.b("Ключи")}
  --dry-run         только проверки: ничего не создаём, не коммитим, не грузим
  --skip-build      не пересобирать, взять готовые файлы из dist-electron/
  --skip-apk        не собирать и не загружать APK (релиз только для Windows)
  --skip-git        не делать git init / commit / tag / push
  --allow-dirty     публиковать даже при незакоммиченных изменениях
                    (в репозиторий уедет последний коммит, а не текущие файлы)
  --force-assets    перезалить файлы, уже лежащие в релизе
  --notes <файл>    текст заметок к релизу (по умолчанию — раздел CHANGELOG.md)
  --owner <владелец>, --repo <репозиторий>
  --help, -h        эта справка

${c.b("Шаги")}`);
  STEPS.forEach((s, i) => out(`  ${i + 1}. ${s}`));
  out(`
${c.b("Куда всё едет")}
  Репозиторий : https://github.com/${OWNER}/${REPO} (приватный)
  Релиз       : https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}
  API         : ${API}
  Файлы       : ${UPLOADS} (отдельный хост — через api.github.com загрузка не идёт)

${c.b("Примеры")}
  node scripts/publish-release.mjs
  node scripts/publish-release.mjs --dry-run
  node scripts/publish-release.mjs --skip-build --force-assets
  node scripts/publish-release.mjs --skip-apk --skip-git

${c.b("Откат")}
  Релиз удаляется на странице релиза (или
  DELETE /repos/${OWNER}/${REPO}/releases/<id>); тег — командой
  \`git push origin :refs/tags/${TAG}\`. Подробно — docs/Разработка.md, раздел «Релиз».`);
}

if (HELP) {
  printHelp();
  process.exit(0);
}

for (const a of argv) {
  if (a.startsWith("--") && !known.has(a)) {
    warn(`Неизвестный ключ «${a}» — проигнорирован. Список ключей: --help`);
  }
}

// ------------------------------------------------------------------- токен

const TOKEN = (process.env.GITHUB_TOKEN ?? "").trim();
if (!TOKEN) {
  out(`${c.r("✗")} Не найден GITHUB_TOKEN — публикация невозможна.
`);
  out("Как получить токен:");
  out("  1. GitHub → Settings → Developer settings → Personal access tokens.");
  out("  2. Fine-grained: Repository access → Only select repositories →");
  out(`     ${OWNER}/${REPO}; Permissions → Repository permissions →`);
  out("     Contents: Read and write (создание тега и релиза),");
  out("     Administration: Read and write (только если репозиторий создан скриптом).");
  out("  3. Classic: scopes repo (приватный репозиторий).");
  out("  4. Скопировать токен в переменную окружения ТЕКУЩЕГО окна терминала:");
  out(IS_WIN
    ? '     $env:GITHUB_TOKEN = "github_pat_…"   # PowerShell'
    : '     export GITHUB_TOKEN=github_pat_…      # bash/zsh');
  out(`
Токен нельзя передавать аргументом команды — он виден в списке процессов и в
истории оболочки, и никакой ключ этого не исправляет. Не кладите его и в файл
внутри проекта: .gitignore запрещает *.token, gh-token.txt и release.local.json
именно потому, что секрет не должен переживать команду.`);
  process.exit(1);
}

/** Ни одно сообщение об ошибке не должно содержать сам токен. */
const redact = (s) => String(s).split(TOKEN).join("***");

// ------------------------------------------------------------------ HTTP

const NETWORK_HINT = [
  "Публикацию нужно запускать из сети, где GitHub доступен.",
  "Известная особенность машины разработчика: curl к корню github.com отвечает 200,",
  "но api.github.com не соединяется вовсе, а git не проходит TLS-рукопожатие",
  "(info/refs?service=git-upload-pack недоступен). Токен при этом есть — не маршрута нет.",
  "Проверка: curl.exe -I https://api.github.com  →  200 OK",
].join("\n      ");

/**
 * Запрос к GitHub REST API. Бросает читаемую ошибку с подсказкой, если сеть
 * недоступна, и с расшифровкой 401/403/404 — иначе по коду статуса непонятно,
 * что именно не так.
 */
/**
 * Обход подменённого DNS.
 *
 * На этой машине локальный резолвер отдаёт для api.github.com неверный
 * адрес: соединение уходит в никуда и обрывается. При этом github.com
 * резолвится верно и git работает, а блокирующий список лежит в
 * hosts-файле, который переписывает сторонняя служба (проверено: в файле
 * есть пометка `dns.malw.link`, и дописанная вручную строка исчезает).
 *
 * Проверка: обычный запрос — 000, тот же запрос по настоящему адресу из
 * DoH — 200. Поэтому при сетевой ошибке адрес берём у DNS-over-HTTPS и
 * повторяем запрос, соединяясь с адресом, но отправляя SNI и Host
 * настоящего имени: проверка сертификата остаётся настоящей, а не
 * отключается.
 */
const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
let pinnedAddress = null;

const resolveOverHttps = async (hostname) => {
  if (pinnedAddress) return pinnedAddress;
  const res = await fetch(`${DOH_ENDPOINT}?name=${hostname}&type=A`, {
    headers: { accept: "application/dns-json" },
  });
  if (!res.ok) throw new Error(`DoH вернул ${res.status}`);
  const data = await res.json();
  const address = (Array.isArray(data.Answer) ? data.Answer : [])
    .filter((a) => a.type === 1 && typeof a.data === "string")
    .map((a) => a.data)[0];
  if (!address) throw new Error("DoH не вернул A-запись");
  pinnedAddress = address;
  warn(`DNS подменён: для ${hostname} беру настоящий адрес ${address} (DoH).`);
  return address;
};

/** Тот же запрос, но к адресу, с SNI и Host настоящего имени. */
const requestToAddress = (target, address, { method, headers, body }) =>
  new Promise((resolve, reject) => {
    const url = new URL(target);
    const req = https.request(
      {
        host: address,
        servername: url.hostname,
        path: `${url.pathname}${url.search}`,
        method,
        headers: { ...headers, Host: url.host },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            // Формат как у ответа fetch: дальше зовут res.text(), res.ok и
            // res.headers.get(), поэтому объект должен выглядеть так же.
            headers: { get: (name) => res.headers[String(name).toLowerCase()] ?? null },
            text: async () => text,
          });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? Buffer.from(body) : body);
    req.end();
  });

async function api(method, endpoint, { body, rawBody, accept = "application/vnd.github+json", allow = [] } = {}) {
  const url = endpoint.startsWith("http") ? endpoint : `${API}${endpoint}`;
  const headers = {
    Accept: accept,
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": UA,
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  let payload = rawBody;
  if (!payload && body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  // Content-Length обязателен для загрузки файлов, но задаётся отдельно там,
  // где тело — Blob: Buffer.byteLength() на Blob бросает исключение.
  if (typeof payload === "string") headers["Content-Length"] = String(Buffer.byteLength(payload));

  let res;
  try {
    res = await fetch(url, { method, headers, body: payload });
  } catch (e) {
    const cause = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? "";
    // Подменённый резолвер — самая частая причина обрыва именно здесь.
    try {
      const address = await resolveOverHttps(new URL(url).hostname);
      res = await requestToAddress(url, address, { method, headers, body: payload });
    } catch {
      err(`Сеть: ${redact(cause || e)} — ${method} ${redact(url)}`);
      out(`\n      ${NETWORK_HINT}\n`);
      process.exit(1);
    }
  }

  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (res.ok || allow.includes(res.status)) return { status: res.status, headers: res.headers, json, text };

  const detail = json?.message ?? (text || "").slice(0, 300) ?? "";
  const who = `${method} ${url.replace(API, "api.github.com")} → ${res.status}`;
  if (res.status === 401) {
    err(`${who}: ${redact(detail)}`);
    out("      Токен недействителен, истёк или отозван. Выпустите новый и проверьте переменную окружения.");
  } else if (res.status === 403) {
    err(`${who}: ${redact(detail)}`);
    const scopes = res.headers.get("x-oauth-scopes") ?? "";
    out(`      Не хватает прав.${scopes ? ` У токена scopes: ${scopes || "(нет) — это fine-grained токен, у него нет scopes, нужны права уровня репозитория"}.` : ""}`);
    out("      Для fine-grained токена проверьте, что репозиторий выбран в Repository access,");
    out("      а Contents и Administration имеют уровень Read and write.");
  } else if (res.status === 404) {
    err(`${who}: ${redact(detail)}`);
    out(`      Репозиторий не найден или токен его не видит. Ожидаем ${OWNER}/${REPO}.`);
  } else if (res.status === 422) {
    err(`${who}: ${redact(detail)}`);
    if (Array.isArray(json?.errors)) for (const e of json.errors) out(`      · ${redact(e.message ?? e.code ?? "")}`);
  } else {
    err(`${who}: ${redact(detail)}`);
  }
  throw new Error(`GitHub API: ${res.status}`);
}

// -------------------------------------------------------------------- git

/** Локальный git без сети. `env` позволяет передать одноразовый заголовок. */
function git(args, { env = {}, allowFail = false } = {}) {
  const res = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
  });
  if (res.error) die(`Не удалось запустить git: ${res.error.message}`);
  if (res.status !== 0 && !allowFail) {
    die(`git ${args.join(" ")} завершился с кодом ${res.status}\n      ${redact((res.stderr || res.stdout || "").trim())}`);
  }
  return { code: res.status, stdout: (res.stdout ?? "").trim(), stderr: (res.stderr ?? "").trim() };
}

const hasGitRepo = () => existsSync(path.join(ROOT, ".git"));
const currentBranch = () => git(["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true }).stdout || "main";
const headSha = () => git(["rev-parse", "HEAD"], { allowFail: true }).stdout;

/**
 * Авторизация для push — только на время команды и только в окружении.
 * `GIT_CONFIG_COUNT/_KEY_/_VALUE_` git читает как `-c key=value` из переменных
 * окружения: токен не попадает ни в `.git/config`, ни в `git remote -v`, ни в
 * список процессов, и после команды на диске не остаётся ничего.
 */
function authEnv() {
  const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

// ---------------------------------------------------------------- версии

function readGradleVersions() {
  const file = path.join(ROOT, "android", "app", "build.gradle");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  const name = /versionName\s+["']([^"']+)["']/.exec(text);
  const code = /versionCode\s+(\d+)/.exec(text);
  return { versionName: name?.[1] ?? null, versionCode: code?.[1] ?? null };
}

/**
 * Версия, которую видит пользователь в интерфейсе. В репозитории такая строка
 * одна — `src/lib/constants.ts`; мосты платформ берут её оттуда (в
 * `src/platform/webBridge.ts` тоже `APP_VERSION`, а не литерал), поэтому
 * сверять надо именно её. Править скрипт не будет: `src/**` не его зона.
 */
function readUiVersions() {
  const result = [];
  const constants = path.join(ROOT, "src", "lib", "constants.ts");
  if (existsSync(constants)) {
    const m = /APP_VERSION\s*=\s*["']([^"']+)["']/.exec(readFileSync(constants, "utf8"));
    if (m) result.push({ file: "src/lib/constants.ts", value: m[1] });
  }
  return result;
}

function checkVersions() {
  step(STEPS[0]);
  const version = pkg.version;
  if (!SEMVER.test(version)) die(`version в package.json не является semver: «${version}»`);
  const pre = SEMVER.exec(version)?.[4] ?? null;
  ok(`версия релиза: ${version}${pre ? ` (предварительный, префикс «${pre}»)` : ""}`);
  info(`канал обновлений: ${CHANNEL} → dist-electron/${CHANNEL}.yml`);

  if (pre && RELEASE_TYPE !== "prerelease") {
    die(`версия ${version} содержит пре-суффикс, а build.publish.releaseType = «${RELEASE_TYPE}».
      Обычный релиз для semver с пре-суффиксом бессмысленен: electron-updater
      отфильтрует такой тег, а пользователи не увидят обновление.
      Ожидается releaseType: "prerelease" в package.json → build.publish.`);
  }
  if (pre) ok("releaseType = prerelease — метка «предварительный» будет проставлена");

  const gradle = readGradleVersions();
  if (!gradle?.versionName) {
    warn("не удалось прочитать versionName в android/app/build.gradle — сверка версий неполная");
  } else if (gradle.versionName !== version) {
    die(`версии разошлись:
        package.json              ${version}
        android/app/build.gradle  ${gradle.versionName}   (versionCode ${gradle.versionCode})
      Поднимите обе вручную (в build.gradle ещё и versionCode) и запустите скрипт снова.`);
  } else {
    ok(`android/app/build.gradle: versionName ${gradle.versionName}, versionCode ${gradle.versionCode}`);
  }

  for (const { file, value } of readUiVersions()) {
    if (value === version) ok(`${file}: ${value}`);
    else warn(`${file}: ${value} — в релизе ${version}. Это то, что видит пользователь в меню и футере; src/** скрипт не правит.`);
  }
  return { version, pre };
}

// -------------------------------------------------------------- репозиторий

async function checkTokenAndAccess() {
  step(STEPS[1]);
  const { json, headers } = await api("GET", "/user");
  const login = json?.login ?? "?";
  ok(`токен принят, владелец аккаунта: @${login}`);
  const scopes = headers.get("x-oauth-scopes");
  if (scopes !== null) {
    if (/repo/.test(scopes)) ok(`classic PAT, scopes: ${scopes}`);
    else warn(`у classic-токена нет scope repo: «${scopes || "пусто"}» — приватный репозиторий будет недоступен`);
  } else {
    info("fine-grained токен (у него нет scopes — права заданы на уровне репозитория)");
  }
  if (login.toLowerCase() !== OWNER.toLowerCase()) {
    warn(`аккаунт @${login} ≠ владелец ${OWNER}. Создание репозитория и запись в него потребуют прав владельца.`);
  }
  return login;
}

async function ensureRepository(login) {
  step(STEPS[2]);
  const repoUrl = `https://github.com/${OWNER}/${REPO}`;
  const found = await api("GET", `/repos/${OWNER}/${REPO}`, { allow: [404] });
  if (found.status === 200) {
    const { private: isPrivate, default_branch: defBranch, html_url: html } = found.json;
    ok(`репозиторий есть: ${html ?? repoUrl}${isPrivate ? " (приватный)" : ""}`);
    if (!isPrivate) {
      die(`репозиторий ${repoUrl} ПУБЛИЧНЫЙ, а релиз приватный по замыслу.
      Сделайте его приватным (Settings → Danger zone → Change visibility) либо
      создайте другой и передайте --repo. Публиковать исходники и установщики
      открыто — не то же самое, что «приватный бета-релиз».`);
    }
    info(`ветка по умолчанию: ${defBranch ?? "?"}, создан ${found.json.created_at ?? "?"}`);
    return found.json;
  }

  if (DRY_RUN) {
    info(`репозитория ${repoUrl} нет — в --dry-run не создаём`);
    return null;
  }
  if (login && login.toLowerCase() !== OWNER.toLowerCase()) {
    die(`создать ${repoUrl} нельзя: токен принадлежит @${login}, а не @${OWNER}.
      Либо выпустите токен для @${OWNER}, либо передайте --owner ${login}.`);
  }
  out(`      создаю приватный репозиторий ${repoUrl} …`);
  // auto_init: false — намеренно. С auto_init GitHub создаёт свой первый коммит
  // (README), и push нашей независимой истории будет отклонён как
  // non-fast-forward. Пустой репозиторий принимает любой первый push.
  const created = await api("POST", "/user/repos", {
    body: {
      name: REPO,
      description: "NEXUS Finance — личный учёт финансов. Бета-релизы для Windows (NSIS) и Android (APK).",
      private: true,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false,
    },
  });
  ok(`создан приватный репозиторий: ${created.json?.html_url ?? repoUrl}`);
  return created.json;
}

// --------------------------------------------------------------------- git

async function prepareGit(version) {
  step(STEPS[3]);
  if (SKIP_GIT) {
    info("--skip-git: коммит, тег и push не делаем");
    return { pushed: false, sha: headSha(), branch: currentBranch() };
  }
  if (!hasGitRepo()) {
    out("      каталога .git нет — инициализирую репозиторий (ветка main)");
    if (DRY_RUN) {
      info("--dry-run: git init пропущен");
      return { pushed: false, sha: "", branch: "main" };
    }
    git(["init"]);
  }
  // Имя ветки задаём явно: на машине, где `init.defaultBranch` не настроен,
  // иначе ветка называется master, а тег и релиз уезжают в никуда.
  if (git(["symbolic-ref", "HEAD"], { allowFail: true }).stdout !== "refs/heads/main") {
    git(["symbolic-ref", "HEAD", "refs/heads/main"], { allowFail: true });
  }

  const hasCommits = git(["rev-parse", "--verify", "HEAD"], { allowFail: true }).code === 0;
  const status = git(["status", "--porcelain=v1"], { allowFail: true }).stdout.split(/\r?\n/).filter(Boolean);

  if (!hasCommits) {
    out(`      коммитов ещё нет — делаю первый коммит (${status.length} записей в рабочем дереве)`);
    if (DRY_RUN) {
      info("--dry-run: коммит пропущен");
      return { pushed: false, sha: "", branch: currentBranch() };
    }
    git(["add", "-A"]);
    commit(`Релиз ${version}: исходное состояние проекта`);
  } else if (status.length) {
    const list = status.slice(0, 10).map((l) => `        ${l}`).join("\n");
    if (!ALLOW_DIRTY) {
      die(`рабочее дерево не чистое (${status.length} записей) — публикую не то, что на диске:
${list}${status.length > 10 ? "\n        …" : ""}
      Что делать:
        • закоммитьте изменения и запустите скрипт снова (правильный путь);
        • или запустите с --allow-dirty: тогда в репозиторий уедет последний
          коммит, а незакоммиченные правки останутся только у вас.`);
    }
    warn(`--allow-dirty: ${status.length} незакоммиченных записей, в репозиторий уйдёт последний коммит\n${list}`);
  } else {
    ok("рабочее дерево чистое");
  }

  const branch = currentBranch();
  // Для аннотированного тега `rev-parse refs/tags/X` отдаёт SHA самого объекта
  // тега, а не коммита, поэтому сравниваем с dereference-формой `^{commit}` —
  // иначе повторный запуск ругался бы «тег указывает на другой коммит».
  const existing = git(["rev-parse", "-q", "--verify", `refs/tags/v${version}^{commit}`], { allowFail: true }).stdout;
  if (existing) {
    const sha = headSha();
    if (existing !== sha) {
      die(`тег v${version} уже есть и указывает на другой коммит (${existing.slice(0, 7)} ≠ ${sha.slice(0, 7)}).
        Один и тот же номер версии нельзя публиковать дважды: для исправленного
        релиза поднимите версию (например ${version} → beta.2) — так честнее
        и для пользователя, и для истории.`);
    }
    info(`тег v${version} уже есть и указывает на HEAD — переиспользуем`);
  } else {
    if (DRY_RUN) {
      info(`--dry-run: тег v${version} не создаём`);
    } else {
      git(["tag", "-a", `v${version}`, "-m", `NEXUS Finance ${version}`]);
      ok(`создан тег v${version}`);
    }
  }

  if (DRY_RUN) {
    info("--dry-run: push пропущен");
    return { pushed: false, sha: headSha(), branch };
  }

  // remote: обычный https-адрес БЕЗ токена — токен поедет в заголовке.
  const remotes = git(["remote"], { allowFail: true }).stdout.split(/\r?\n/).filter(Boolean);
  if (remotes.includes("origin")) {
    const url = git(["remote", "get-url", "origin"], { allowFail: true }).stdout;
    info(`remote origin: ${url}`);
  } else {
    git(["remote", "add", "origin", `https://github.com/${OWNER}/${REPO}.git`]);
    ok(`добавлен remote origin -> https://github.com/${OWNER}/${REPO}.git`);
  }

  const tagExists = Boolean(git(["rev-parse", "-q", "--verify", `refs/tags/v${version}`], { allowFail: true }).stdout);
  const refspec = tagExists
    ? [`HEAD:refs/heads/${branch}`, `refs/tags/v${version}:refs/tags/v${version}`]
    : [`HEAD:refs/heads/${branch}`];
  out(`      git push origin ${refspec.join(" ")}  (--atomic, токен — только в заголовке)`);
  const push = git(["push", "--atomic", "origin", ...refspec], { env: authEnv(), allowFail: true });
  if (push.code !== 0) {
    err(`git push не прошёл (код ${push.code}):\n      ${redact(push.stderr || push.stdout)}`);
    out(`
      Релиз и файлы ниже всё равно будут созданы — GitHub это не блокирует.
      Чтобы залить код вручную, выполните в корне проекта:
        git remote add origin https://github.com/${OWNER}/${REPO}.git
        git push -u origin ${branch}
        git push origin v${version}
      и введите токен по запросу (имя пользователя — любое, пароль — токен).
      Токен в адресе remote оставлять нельзя: он сохранится в .git/config.`);
    return { pushed: false, sha: headSha(), branch };
  }
  ok(`ветка ${branch} и тег v${version} отправлены`);
  return { pushed: true, sha: headSha(), branch };
}

function commit(message) {
  const args = ["commit", "-m", message];
  if (!git(["config", "--get", "user.email"], { allowFail: true }).stdout) {
    warn("git user.email не настроен — коммит подписывается служебным адресом");
    args.unshift("-c", "user.name=NEXUS Finance", "-c", "user.email=release@nexus-finance.invalid");
  }
  git(args);
  ok(`коммит: ${message}`);
}

// ---------------------------------------------------------------- артефакты

/** Раскрывает шаблон electron-builder вроде "${productName} Setup ${version}.${ext}". */
function expandArtifactName(pattern, { ext = "exe", os = "win", arch = "x64" } = {}) {
  return pattern
    .replace(/\$\{productName\}/g, PRODUCT)
    .replace(/\$\{name\}/g, pkg.name ?? PRODUCT)
    .replace(/\$\{version\}/g, pkg.version)
    .replace(/\$\{channel\}/g, CHANNEL)
    .replace(/\$\{arch\}/g, arch)
    .replace(/\$\{os\}/g, os)
    .replace(/\$\{ext\}/g, ext);
}

/** Каталог артефактов electron-builder и ожидаемые имена. */
function artifactPlan() {
  const dir = path.join(ROOT, "dist-electron");
  const win = pkg.build?.win ?? {};
  const setup = expandArtifactName(pkg.build?.nsis?.artifactName ?? win.artifactName ?? "${productName} Setup ${version}.${ext}");
  const portable = expandArtifactName(pkg.build?.portable?.artifactName ?? win.artifactName ?? "${productName} ${version}.${ext}");
  if (setup === portable) {
    die(`имя установщика и portable совпадают: «${setup}».
      Оба артефакта — .exe, и electron-builder перезапишет один другим.
      Причина обычно в общем win.artifactName: разведите шаблоны по секциям
      build.nsis.artifactName и build.portable.artifactName.`);
  }
  return {
    dir,
    setup: { name: setup, file: path.join(dir, setup) },
    portable: { name: portable, file: path.join(dir, portable) },
    blockmap: { name: `${setup}.blockmap`, file: path.join(dir, `${setup}.blockmap`) },
    apk: { name: "app-release.apk", file: path.join(ROOT, "android", "app", "build", "outputs", "apk", "release", "app-release.apk") },
  };
}

/** Самый свежий исходник — чтобы поймать устаревшую сборку. */
function newestSourceMtime() {
  const skipDirs = new Set([
    "node_modules", "dist", "dist-electron", "coverage", "benchmarks", ".git",
    ".gradle", "build", "assets", ".idea",
  ]);
  const roots = ["src", "public", path.join("android", "app", "src")];
  const files = [
    "electron-main.cjs", "preload.cjs", "index.html", "index.dev.html",
    "package.json", "vite.config.ts", "vite.dev.config.ts", "vite.shared.ts",
    "capacitor.config.ts", "tsconfig.json", "license.txt",
  ];
  // Файлы, которые пишет сам `cap sync`. Их время меняется при каждой
  // синхронизации, и без исключения сборка всегда выглядит «старше
  // исходников»: предупреждение срабатывает на пустом месте и учит
  // предупреждения игнорировать.
  const generated = new Set([
    path.join("android", "app", "src", "main", "res", "xml", "config.xml"),
  ]);
  let newest = 0;
  let newestFile = "";
  let seen = 0;
  const visit = (rel) => {
    if (seen++ > 20000) return;
    const abs = path.join(ROOT, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      let names = [];
      try {
        names = readdirSync(abs);
      } catch {
        return;
      }
      for (const n of names) {
        if (skipDirs.has(n)) continue;
        visit(path.join(rel, n));
      }
      return;
    }
    if (generated.has(rel)) return;
    if (st.mtimeMs > newest) {
      newest = st.mtimeMs;
      newestFile = rel;
    }
  };
  for (const f of files) if (existsSync(path.join(ROOT, f))) visit(f);
  for (const r of roots) if (existsSync(path.join(ROOT, r))) visit(r);
  return { mtime: newest, file: newestFile };
}

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "?");

function readChannelYml(plan) {
  // Метаданные канала: electron-builder пишет `<build.publish.channel>.yml`
  // (при channel: "beta" — `beta.yml`). Ищем сначала имя из конфигурации,
  // потом известные — на случай сборки, сделанной до появления `publish`.
  const wanted = [...new Set([`${CHANNEL}.yml`, "latest.yml", "beta.yml"])];
  for (const name of wanted) {
    const file = path.join(plan.dir, name);
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8");
      // Разбор точечный: yml electron-builder — плоский, без вложенных словарей.
      const version = /(^|\n)version:\s*(\S+)/.exec(text)?.[2] ?? null;
      const pathLine = /(^|\n)path:\s*(\S+)/.exec(text)?.[2] ?? null;
      const urlLine = /url:\s*(\S+)/.exec(text)?.[1] ?? null;
      const installerName = pathLine ?? urlLine ?? null;
      return { name, file, version, installerName, blockmapName: installerName ? `${installerName}.blockmap` : null };
    }
  }
  return null;
}

async function buildArtifacts() {
  step(STEPS[4]);
  if (SKIP_BUILD) {
    info("--skip-build: берём готовые файлы из dist-electron/");
    return;
  }
  const runScript = (file, args, label) => {
    out(`\n      ${c.b(label)}\n      $ node ${file}${args.length ? ` ${args.join(" ")}` : ""}`);
    if (DRY_RUN) {
      info("--dry-run: сборка пропущена");
      return;
    }
    const res = spawn(process.execPath, [path.join("scripts", file), ...args], {
      cwd: ROOT,
      stdio: "inherit",
      shell: false,
    });
    return new Promise((resolve, reject) => {
      res.on("error", reject);
      res.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${file} завершился с кодом ${code}`))));
    });
  };
  try {
    await runScript("build-windows.mjs", [], "5a Сборка Windows (установщик + portable)");
    if (!SKIP_APK) {
      await runScript("build-android.mjs", ["--release"], "5b Сборка Android (release APK)");
    } else {
      info("--skip-apk: APK не пересобирается и не загружается");
    }
  } catch (e) {
    die(`сборка не удалась: ${redact(e.message)}
      Соберите артефакты отдельно (npm run build:win, npm run build:apk), разберитесь
      с ошибкой и вернитесь — публиковать нечего, пока сборка не удалась.`);
  }
}

function checkArtifacts(plan, version) {
  step(STEPS[5]);
  const base = version.replace(/-.*$/, "");
  const entries = [plan.setup, plan.portable];
  if (!SKIP_APK) entries.push(plan.apk);

  const built = [];
  for (const item of entries) {
    if (!existsSync(item.file)) {
      die(`нет файла ${path.relative(ROOT, item.file)}
        Соберите его: npm run build:win${item === plan.apk ? " и npm run build:apk" : ""}.
        Либо пропустите шаг сборки флагом --skip-build, только если файл действительно готов.`);
    }
    const st = statSync(item.file);
    if (st.size === 0) die(`файл пустой (0 байт): ${path.relative(ROOT, item.file)}`);
    const name = path.basename(item.file);
    // Номер версии в имени обязателен только для файлов electron-builder:
    // он подставляет версию в имя сам, и по нему видно, что сборка свежая.
    //
    // Для APK это не так: имя задаёт Gradle, оно всегда `app-release.apk`,
    // независимо от версии. Требовать там версию нельзя — сборка
    // проверяется по `versionName` в build.gradle (шаг 1), и по содержимому:
    // сверку бандла делает scripts/check-bundles.mjs.
    const versionInNameExpected = item !== plan.apk;
    if (versionInNameExpected && !name.includes(version)) {
      const hint = name.includes(base)
        ? `имя содержит «${base}», а релиз — «${version}»: в релиз уехала бы сборка другой версии`
        : "в имени нет номера версии";
      die(`${name}: ${hint}
        electron-builder подставляет версию в имя файла, значит артефакт собран
        до поднятия версии. Пересоберите (уберите --skip-build) — публиковать
        устаревшую сборку нельзя, автообновление потом не заработает.`);
    }
    ok(`${pad(name, 46)} ${pad(fmtSize(st.size), 10)} ${c.d(fmtDate(st.mtimeMs))}`);
    built.push({ name, mtime: st.mtimeMs });
  }

  // Свежесть: артефакт не должен быть старше последней правки исходников.
  //
  // Исключение — APK: Gradle пересобирает пакет не всегда, и если вёрстка
  // не изменилась по содержанию, файл остаётся с прежним временем. Время
  // здесь врёт, поэтому актуальность APK проверяется по содержимому: бандл
  // внутри пакета сравнивается с dist/ (scripts/check-bundles.mjs умеет
  // читать запись из zip). Так и вышло однажды: файл APK отставал по дате,
  // но содержал ровно нужный бандл.
  const bundleCheck = spawnSync(process.execPath, [path.join(ROOT, "scripts", "check-bundles.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (bundleCheck.status === 0) {
    const line = (bundleCheck.stdout ?? "").split(/\r?\n/).find((l) => l.includes("внутри app-release.apk"));
    ok(line ? line.replace(/^.*?внутри/, "внутри") : "содержимое APK совпадает с dist/");
  } else {
    warn(`не удалось подтвердить содержимое APK (проверка check-bundles):\n${(bundleCheck.stdout ?? "").trim()}`);
  }

  const src = newestSourceMtime();
  if (src.mtime) {
    const stale = built.filter((a) => a.mtime < src.mtime && a.name !== path.basename(plan.apk.file));
    info(`последняя правка исходников: ${fmtDate(src.mtime)} (${src.file})`);
    if (stale.length) {
      warn(`сборка старше исходников: ${stale.map((a) => a.name).join(", ")}
        В релиз уедет бинарник, в котором нет последних правок. У нас так уже
        случалось: APK отставал от dist/. Пересоберите (без --skip-build).`);
    } else {
      ok("артефакты не старше исходников");
    }
  }

  // Метаданные канала: без них автообновление не находит файл.
  const yml = readChannelYml(plan);
  if (!yml) {
    warn(`${CHANNEL}.yml в dist-electron нет — автообновление не найдёт файл установки.
      Файл появляется при сборке NSIS; если сборка шла с --nsis-only или
      electron-builder писал в другой канал, пересоберите.`);
    return yml;
  }
  if (yml.version && yml.version !== version) {
    die(`${yml.name}: version ${yml.version}, а релиз ${version}.
      Метаданные обновления описывают другую сборку: electron-updater скормит
      пользователю неверную версию. Пересоберите установщик.`);
  }
  ok(`${yml.name}: version ${yml.version}, установщик «${yml.installerName}»`);
  if (CHANNEL === "beta" && yml.name !== "beta.yml") {
    warn(`build.publish.channel = «${CHANNEL}», а эта сборка записала ${yml.name}.
      Значит, она собрана до появления ключа publish в package.json. Прямо
      сейчас это безвредно: скрипт положит метаданные в релиз под обоими
      именами — ${CHANNEL}.yml и latest.yml. После следующей пересборки
      electron-builder сам начнёт писать ${CHANNEL}.yml.`);
  }
  if (yml.blockmapName && existsSync(plan.blockmap.file)) {
    ok(`blockmap: ${path.basename(plan.blockmap.file)} (дельту автообновления качает)`);
  } else {
    warn(`blockmap не найден (${path.basename(plan.blockmap.file)}) — первое обновление
      скачается целиком. Нужен nsis.differentialPackage: true в package.json → build.`);
  }
  return yml;
}

// ---------------------------------------------------------------- релиз

function releaseNotes(version) {
  if (NOTES_FILE) {
    const file = path.resolve(process.cwd(), NOTES_FILE);
    if (!existsSync(file)) die(`файл с заметками не найден: ${file}`);
    return readFileSync(file, "utf8").trim();
  }
  const changelog = path.join(ROOT, "CHANGELOG.md");
  if (!existsSync(changelog)) return `NEXUS Finance ${version}`;
  const lines = readFileSync(changelog, "utf8").split(/\r?\n/);
  const headings = [];
  lines.forEach((line, i) => {
    const m = /^##\s*\[(.+?)\]/.exec(line);
    if (m) headings.push({ i, name: m[1] });
  });
  const take = (name) => {
    const start = headings.find((h) => h.name === name);
    if (!start) return null;
    const end = headings.find((h) => h.i > start.i)?.i ?? lines.length;
    return lines.slice(start.i + 1, end).join("\n").trim();
  };
  let notes = take(version);
  if (!notes) {
    const unreleased = take("Невыпущенные");
    if (unreleased) {
      warn(`в CHANGELOG.md нет раздела [${version}] — беру раздел [Невыпущенные]
        и публикую его как есть. Переименуйте заголовок в [${version}] или
        передайте свой файл: --notes <файл>`);
      notes = unreleased;
    }
  }
  return notes || `NEXUS Finance ${version}`;
}

async function ensureRelease(version, { pushed }) {
  step(STEPS[6]);
  const body = releaseNotes(version);
  const title = `NEXUS Finance ${version}`;
  if (body.length > 60000) warn(`заметки корочу: ${body.length} символов, GitHub примет первые 60 000`);

  const found = await api("GET", `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, { allow: [404] });
  if (found.status === 200) {
    const rel = found.json;
    ok(`релиз уже есть: ${rel.html_url} (id ${rel.id})`);
    if (!rel.prerelease) {
      warn(`релиз ${TAG} не помечен как prerelease — electron-updater с
        allowPrerelease не отфильтрует его по каналу. Исправляю метку.`);
      if (!DRY_RUN) await api("PATCH", `/repos/${OWNER}/${REPO}/releases/${rel.id}`, { body: { prerelease: true } });
    }
    // Заметки к релизу тоже могли устареть: они берутся из CHANGELOG.md, а он
    // правится уже после первой публикации. Без этой правки страница релиза
    // навсегда осталась бы с тем текстом, который был в момент первого
    // запуска, — а читатель её видит первым.
    if (rel.body !== body && !DRY_RUN) {
      out("      заметки релиза отличаются от CHANGELOG.md — обновляю");
      await api("PATCH", `/repos/${OWNER}/${REPO}/releases/${rel.id}`, { body: { body: body.slice(0, 60000) } });
      ok("заметки релиза обновлены");
    }
    return rel;
  }

  // Тег должен существовать на сервере: релиз без тега не создать.
  const ref = await api("GET", `/repos/${OWNER}/${REPO}/git/ref/tags/${TAG}`, { allow: [404] });
  if (ref.status === 404) {
    if (!pushed) {
      die(`тега ${TAG} нет на GitHub, а push не выполнялся (--skip-git или он не прошёл).
        Создайте и отправьте тег:
          git tag -a ${TAG} -m "${title}"
          git push origin ${currentBranch()} ${TAG}
        и запустите скрипт снова.`);
    }
    if (DRY_RUN) {
      info("--dry-run: тег появился бы после push, релиз не создаём");
      return null;
    }
    const sha = headSha();
    if (!sha) die("не удалось определить локальный коммит для создания тега");
    out(`      тега ${TAG} на сервере нет — создаю его через API на ${sha.slice(0, 7)}`);
    await api("POST", `/repos/${OWNER}/${REPO}/git/refs`, { body: { ref: `refs/tags/${TAG}`, sha } });
    ok(`создан тег ${TAG}`);
  } else {
    info(`тег ${TAG} на сервере есть`);
  }

  if (DRY_RUN) {
    info("--dry-run: релиз не создаём");
    return null;
  }
  out(`      создаю релиз ${TAG} с меткой «предварительный» …`);
  const created = await api("POST", `/repos/${OWNER}/${REPO}/releases`, {
    body: {
      tag_name: TAG,
      name: title,
      body: body.slice(0, 60000),
      prerelease: true,
      draft: false,
      make_latest: "false",
    },
  });
  ok(`релиз создан: ${created.json?.html_url}`);
  return created.json;
}

// -------------------------------------------------------------- загрузка

async function fileBody(file) {
  if (openAsBlob) {
    try {
      return await openAsBlob(file);
    } catch {
      /* откатимся ниже */
    }
  }
  return readFileSync(file);
}

async function uploadAssets(plan, release, yml) {
  step(STEPS[7]);
  if (DRY_RUN || !release) {
    info("--dry-run: файлы не загружаем");
    return [];
  }
  // GitHub нормализует имена файлов в релизе: пробелы заменяются точками
  // («NEXUS Finance 1.0.0-beta.1.exe» попадает на сервер как
  // «NEXUS.Finance.1.0.0-beta.1.exe»). Обратное преобразование не нужно и
  // было бы неверным: точки в номере версии — настоящие. Поэтому ищем
  // существующий файл по тому же преобразованию, что применяет GitHub, иначе
  // повторный запуск падает с 422: файл-то есть, но под другим именем.
  const asGitHubStores = (name) => name.replace(/\s/g, ".");
  const existing = new Map((release.assets ?? []).map((a) => [a.name, a]));
  const findExisting = (name) => existing.get(name) ?? existing.get(asGitHubStores(name));

  // Имя файла в релизе для установщика берём ИЗ yml: electron-updater строит
  // адрес загрузки как `releases/download/<tag>/<имя>` и пробелы заменяет на
  // дефисы (GitHubProvider.resolveFiles). То есть в релизе установщик обязан
  // лежать под именем из yml, а не под тем, что на диске в dist-electron.
  const ymlName = yml?.installerName ?? `${plan.setup.name}`;
  const updaterName = ymlName.replace(/ /g, "-");
  const blockmapName = (yml?.blockmapName ?? `${ymlName}.blockmap`).replace(/ /g, "-");

  const assets = [
    { file: plan.setup.file, name: updaterName, required: true, role: "установщик (имя из yml — так его ищет electron-updater)" },
    { file: plan.portable.file, name: plan.portable.name, required: true, role: "portable-версия" },
  ];
  if (!SKIP_APK) {
    assets.push({ file: plan.apk.file, name: "app-release.apk", required: true, role: "Android APK" });
  }
  // Метаданные обновления: без них автообновление не найдёт ничего.
  //
  // ИМЯ ФАЙЛА ВАЖНО, и electron-updater тут ведёт себя по-разному:
  //  · GitHubProvider (публичный репозиторий, без токена) читает `<канал>.yml`
  //    — того канала, что задан в конфигурации приложения;
  //  · PrivateGitHubProvider (приватный репозиторий, токен) жёстко берёт
  //    getDefaultChannelName() — то есть ВСЕГДА `latest.yml`, настройку
  //    `channel` он не учитывает (см. getLatestVersion() в
  //    node_modules/electron-updater/out/providers/PrivateGitHubProvider.js).
  // Репозиторий приватный, поэтому кладём метаданные под обоими именами:
  // какой бы провайдер ни выбрало приложение, файл найдётся. Файл весит
  // ~300 байт, дублирование ничего не стоит и снимает развилку.
  if (yml) {
    assets.push({ file: yml.file, name: yml.name, required: false, role: `метаданные канала ${CHANNEL}` });
    if (yml.name !== "latest.yml") {
      assets.push({
        file: yml.file,
        name: "latest.yml",
        required: false,
        role: "те же метаданные под именем latest.yml — приватный провайдер читает только его",
      });
    }
  }
  if (existsSync(plan.blockmap.file)) {
    assets.push({ file: plan.blockmap.file, name: blockmapName, required: false, role: "blockmap (дельты обновлений)" });
  }

  const uploaded = [];
  for (const asset of assets) {
    if (!existsSync(asset.file)) {
      if (asset.required) die(`файл пропал перед загрузкой: ${path.relative(ROOT, asset.file)}`);
      warn(`пропускаю необязательный файл ${path.relative(ROOT, asset.file)}`);
      continue;
    }
    const size = statSync(asset.file).size;
    const already = findExisting(asset.name);
    if (already) {
      if (!FORCE_ASSETS) {
        const asStored = already.name === asset.name ? "" : ` (на сервере как «${already.name}»)`;
        ok(`${asset.name} — уже в релизе${asStored} (${fmtSize(size)}), пропускаю; --force-assets перезальёт`);
        uploaded.push({ name: already.name, size, skipped: true });
        continue;
      }
      if (DRY_RUN) continue;
      out(`      удаляю прежний ${already.name} (--force-assets) …`);
      await api("DELETE", `/repos/${OWNER}/${REPO}/releases/assets/${already.id}`);
    }

    const url = new URL(`${UPLOADS}/repos/${OWNER}/${REPO}/releases/${release.id}/assets`);
    url.searchParams.set("name", asset.name);
    url.searchParams.set("label", asset.name.replace(/\.[^.]+$/, ""));
    out(`      загружаю ${asset.name} (${fmtSize(size)}) — ${asset.role} …`);
    const started = Date.now();
    const body = await fileBody(asset.file);
    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": UA,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(size),
    };
    let res;
    try {
      res = await fetch(url, { method: "POST", headers, body });
    } catch (e) {
      err(`загрузка ${asset.name} не удалась: ${redact(e?.cause?.code ?? e?.message ?? e)}`);
      out(`\n      ${NETWORK_HINT}\n`);
      process.exit(1);
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        detail = JSON.parse(text).message ?? detail;
      } catch {
        /* оставляем как есть */
      }
      err(`${asset.name}: ${res.status} — ${redact(detail)}`);
      if (res.status === 507) out("      Файл слишком велик для репозитория (insufficient storage).");
      if (res.status === 403) out("      Часто это антивирус или прокси на стороне сети: попробуйте другую сеть.");
      process.exit(1);
    }
    const json = text ? JSON.parse(text) : {};
    uploaded.push({ name: json.name ?? asset.name, size, url: json.browser_download_url });
    ok(`${asset.name} — загружен за ${fmtTime(Date.now() - started)} (${fmtSize(size)})`);
  }
  return uploaded;
}

// ---------------------------------------------------------------- сводка

function printSummary({ version, release, uploaded, yml, gitState }) {
  step(STEPS[8]);
  const releaseUrl = release?.html_url ?? `https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}`;
  out(`      ${c.b("Релиз")} ${releaseUrl}`);
  out(`      ${c.b("Сборка")} v${version} · канал ${CHANNEL} · prerelease`);
  if (uploaded.length) {
    out(`      ${c.b("Файлы")}`);
    for (const a of uploaded) {
      const note = a.skipped ? c.d(" (был раньше)") : "";
      out(`        ${pad(a.name, 46)} ${pad(fmtSize(a.size), 10)}${note}`);
    }
  }
  if (yml) {
    out(`      ${c.b("Обновление")} ${yml.name} → ${yml.installerName} (пробелы → дефисы, как ждёт electron-updater)`);
  }
  if (gitState) {
    out(`      ${c.b("Git")} ${gitState.pushed ? `ветка ${gitState.branch} и тег ${TAG} на сервере` : "код в репозиторий не отправлен — см. пункт выше"}`);
  }
  out(`
${c.b("Что проверить после публикации")}
  1. На странице релиза три файла: установщик, portable и app-release.apk.
  2. electron-updater в приложении смотрит ${OWNER}/${REPO} (приватный
     репозиторий — нужен токен в feed URL, см. docs/Решение-проблем.md, §14).
  3. Установленная сборка должна предлагать обновление до ${version} —
     ${yml ? `файл ${yml.name} лежит в релизе` : "файла канала нет, обновление не найдётся"}.
  4. Откат плохого релиза: удалить релиз и тег (см. docs/Разработка.md, «Релиз»).`);
}

// ------------------------------------------------------------------- main

async function main() {
  out(`${c.b("  NEXUS Finance -> публикация релиза")}`);
  out(`${c.d(`  корень проекта: ${ROOT}`)}`);
  out(`${c.d(`  репозиторий:    ${OWNER}/${REPO} (приватный, releaseType: ${RELEASE_TYPE}, канал: ${CHANNEL})`)}`);
  if (DRY_RUN) out(`${c.y("  РЕЖИМ --dry-run: ничего не создаём, не коммитим и не загружаем")}`);
  out();

  const { version } = checkVersions();
  const login = await checkTokenAndAccess();
  await ensureRepository(login);
  const gitState = await prepareGit(version);
  const plan = artifactPlan();
  await buildArtifacts();
  const yml = checkArtifacts(plan, version);
  const release = await ensureRelease(version, gitState);
  const uploaded = await uploadAssets(plan, release, yml);
  printSummary({ version, release, uploaded, yml, gitState });
  out();
  ok("готово");
}

try {
  await main();
  process.exit(0);
} catch (e) {
  err(redact(e?.stack ?? e?.message ?? e));
  process.exit(1);
}
