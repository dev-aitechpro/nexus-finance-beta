#!/usr/bin/env node
/**
 * Сборка Android-версии NEXUS Finance (Capacitor 8) одной командой.
 *
 *   node scripts/build-android.mjs                 # и debug, и release
 *   node scripts/build-android.mjs --release       # только подписанный release
 *   node scripts/build-android.mjs --debug         # только debug
 *   node scripts/build-android.mjs --icons         # перегенерировать mipmap из public/favicon.ico
 *   node scripts/build-android.mjs --no-sync       # не запускать `npx cap sync android`
 *   node scripts/build-android.mjs --retries 12    # больше повторов при обрывах TLS
 *   node scripts/build-android.mjs --clean         # gradlew clean перед сборкой
 *   node scripts/build-android.mjs --with-web      # сначала `npm run build`
 *
 * Что делает:
 *   1) находит Android SDK и JDK (или берёт из переменных окружения);
 *   2) находит JDK 21 — AGP 8.13 требует его как Gradle-тулчейн (подробности в
 *      комментарии android/build.gradle) — и передаёт -Porg.gradle.java.installations.paths;
 *   3) синхронизирует веб-ассеты: `npx cap sync android`
 *      (dist/ -> android/app/src/main/assets/public) и сверяет размер index.html;
 *   4) запускает gradlew assembleDebug / assembleRelease с повторами: локальный
 *      TUN-прокси в этой сети периодически рвёт TLS ("Remote host terminated the
 *      handshake"), и без повторов сборка выглядит «сломанной»;
 *   5) печатает путь, размер и badging готовых APK.
 *
 * Абсолютных путей в репозитории нет: SDK/JDK ищутся в переменных окружения,
 * android/local.properties и стандартных местах установки.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_DIR = join(ROOT, 'android');
const isWin = process.platform === 'win32';

// ------------------------------------------------------------------ аргументы
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DO_DEBUG = has('--debug') || !has('--release');
const DO_RELEASE = has('--release') || !has('--debug');
const DO_SYNC = !has('--no-sync');
const DO_ICONS = has('--icons');
const DO_CLEAN = has('--clean');
const DO_WEB = has('--with-web');
const RETRIES = Number(val('--retries', '8')) || 8;

// --------------------------------------------------------------------- вывод
const c = {
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  d: (s) => `\x1b[90m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};
const log = (m = '') => process.stdout.write(m + '\n');
const step = (m) => log(`${c.b('==>')} ${m}`);
const warn = (m) => log(`${c.y('ВНИМАНИЕ:')} ${m}`);
const fail = (m) => { log(c.r(`ОШИБКА: ${m}`)); process.exit(1); };

function run(cmd, args, opts = {}) {
  const base = {
    cwd: opts.cwd ?? ROOT,
    stdio: opts.quiet ? 'pipe' : 'inherit',
    env: { ...process.env, ...(opts.env ?? {}) },
  };
  if (isWin && /\.(bat|cmd)$/i.test(cmd)) {
    // Node >= 18.20 запрещает прямой spawn .bat/.cmd (EINVAL) — нужен shell.
    return spawnSync([cmd, ...args].map(quoteWinArg).join(' '), { ...base, shell: true });
  }
  return spawnSync(cmd, args, base);
}

function capture(cmd, args, opts = {}) {
  const base = {
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
  };
  if (isWin && /\.(bat|cmd)$/i.test(cmd)) {
    const r = spawnSync([cmd, ...args].map(quoteWinArg).join(' '), { ...base, shell: true });
    return (r.stdout ?? '') + (r.stderr ?? '');
  }
  const r = spawnSync(cmd, args, base);
  return (r.stdout ?? '') + (r.stderr ?? '');
}

/** Экранирование аргумента для командной строки cmd.exe. */
function quoteWinArg(a) {
  const s = String(a);
  // -P...paths=C:\... содержит '\' — для cmd это обычный символ, кавычки не нужны
  return /[\s"&|<>^()%,;=]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const sleep = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`]);

// ------------------------------------------------------- поиск Android SDK
function findAndroidSdk() {
  const fromEnv = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (fromEnv && existsSync(fromEnv)) return { dir: fromEnv, from: 'ANDROID_HOME' };

  const lp = join(ANDROID_DIR, 'local.properties');
  if (existsSync(lp)) {
    const m = /^sdk\.dir\s*=\s*(.+)$/m.exec(readFileSync(lp, 'utf8'));
    if (m) {
      // в .properties экранированы ':' и '\'
      const dir = m[1].trim().replace(/\\:/g, ':').replace(/\\\\/g, '\\');
      if (existsSync(dir)) return { dir, from: 'android/local.properties' };
    }
  }

  const home = os.homedir();
  const guesses = isWin
    ? [join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Android', 'Sdk'), join(home, 'AppData', 'Local', 'Android', 'Sdk')]
    : [join(home, 'Android', 'Sdk'), join(home, 'Library', 'Android', 'sdk')];
  for (const g of guesses) if (g && existsSync(g)) return { dir: g, from: 'стандартное расположение' };
  return null;
}

// --------------------------------------------------------------- поиск JDK'ов
/** JDK, которым запускается сам Gradle (нужен >= 21 для Gradle 9.3.1). */
function findGradleJdk() {
  if (process.env.JAVA_HOME && existsSync(join(process.env.JAVA_HOME, 'bin'))) return process.env.JAVA_HOME;
  if (isWin) {
    const drive = process.env.SystemDrive ?? 'C:';
    const jbr = join(drive, 'Program Files', 'Android', 'Android Studio', 'jbr');
    if (existsSync(join(jbr, 'bin', 'java.exe'))) return jbr;
  } else {
    for (const p of ['/usr/lib/jvm/default-java', '/usr']) if (existsSync(join(p, 'bin', 'java'))) return p;
  }
  const out = capture('java', ['-XshowSettings:properties', '-version']);
  const m = /java\.home\s*=\s*(.+)/.exec(out);
  if (m && existsSync(m[1].trim())) return m[1].trim();
  return null;
}

/**
 * JDK 21 для Gradle-тулчейна.
 * AGP 8.13 берёт компилятор для каждой задачи JavaCompile из тулчейна с
 * languageVersion == compileOptions.targetCompatibility. У Capacitor 8 это 21,
 * поэтому физически установленный JDK 21 обязателен: иначе
 * ToolchainProvisioningException. Ищем его, НЕ хардкодя путь в репозитории.
 */
function findJdk21() {
  const home = os.homedir();
  const roots = [];
  const push = (base, re) => { if (base && existsSync(base)) roots.push({ base, re }); };

  if (process.env.NEXUS_JDK21) push(process.env.NEXUS_JDK21, null);
  // сюда Gradle распаковывает auto-provisioned тулчейны; мы кладём JDK 21 сюда же
  push(join(home, '.gradle', 'jdks'), /^(jdk|temurin|zulu|corretto|graalvm|openjdk)?-?21/i);
  push(join(home, '.jdks'), /21/i);
  if (isWin) {
    const drive = process.env.SystemDrive ?? 'C:';
    for (const d of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Amazon Corretto', 'Zulu', 'BellSoft', 'Android/Android Studio/jbr']) {
      push(join(drive, 'Program Files', ...d.split('/')), /^(jdk|temurin|zulu|corretto|openjdk)-?21/i);
    }
  } else {
    push('/usr/lib/jvm', /-21-|^21/i);
    push('/Library/Java/JavaVirtualMachines', /21/i);
  }

  const isJdk = (d) => existsSync(join(d, 'bin', 'javac')) || existsSync(join(d, 'bin', 'javac.exe'));
  for (const { base, re } of roots) {
    for (const name of readdirSync(base)) {
      const full = join(base, name);
      if (!statSync(full).isDirectory()) continue;
      if (re && !re.test(name)) continue;
      if (isJdk(full)) return full;                                   // обычный JDK
      const mac = join(full, 'Contents', 'Home');                   // macOS bundle
      if (isJdk(mac)) return mac;
    }
  }
  return null;
}

function pickBuildTools(dir) {
  const bt = join(dir, 'build-tools');
  if (!existsSync(bt)) return '';
  return readdirSync(bt).filter((v) => statSync(join(bt, v)).isDirectory()).sort().pop() ?? '';
}

function findAapt2(dir) {
  const bt = join(dir, 'build-tools');
  if (!existsSync(bt)) return null;
  const versions = readdirSync(bt).filter((v) => statSync(join(bt, v)).isDirectory()).sort().reverse();
  for (const v of versions) {
    const p = join(bt, v, isWin ? 'aapt2.exe' : 'aapt2');
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------- окружение
log();
log(c.b('  NEXUS Finance -> сборка Android (Capacitor 8)'));
log(c.d(`  корень проекта: ${ROOT}`));
log();

const sdk = findAndroidSdk();
if (!sdk) fail('Не найден Android SDK. Задайте ANDROID_HOME или sdk.dir в android/local.properties.');
step(`Android SDK: ${sdk.dir}  ${c.d(`(из ${sdk.from})`)}`);

const javaHome = findGradleJdk();
if (!javaHome) fail('Не найден JDK для запуска Gradle. Задайте JAVA_HOME.');
step(`JDK для Gradle: ${javaHome}`);

const jdk21 = findJdk21();
if (jdk21) step(`JDK 21 (тулчейн для AGP): ${jdk21}`);
else warn('JDK 21 не найден — AGP 8.13 упадёт с ToolchainProvisioningException.\n' +
         '        Поставьте JDK 21 (например, распакуйте в %USERPROFILE%\\.gradle\\jdks\\jdk-21...)\n' +
         '        или укажите путь в переменной окружения NEXUS_JDK21.');

// local.properties обязателен: переменные ANDROID_* в системе не выставлены
const localProps = join(ANDROID_DIR, 'local.properties');
const lpText = existsSync(localProps) ? readFileSync(localProps, 'utf8') : '';
if (!/^sdk\.dir\s*=/m.test(lpText)) {
  const esc = sdk.dir.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  mkdirSync(ANDROID_DIR, { recursive: true });
  writeFileSync(localProps, `## Создано scripts/build-android.mjs (машино-зависимый файл, в git не нужен)\nsdk.dir=${esc}\n`, 'utf8');
  step(`записан android/local.properties: sdk.dir=${sdk.dir}`);
}

const btVersion = pickBuildTools(sdk.dir);
const env = {
  ANDROID_HOME: sdk.dir,
  ANDROID_SDK_ROOT: sdk.dir,
  JAVA_HOME: javaHome,
  PATH: [
    join(javaHome, 'bin'),
    join(sdk.dir, 'platform-tools'),
    btVersion && join(sdk.dir, 'build-tools', btVersion),
    process.env.PATH,
  ].filter(Boolean).join(isWin ? ';' : ':'),
};

const gradleArgs = [];
if (jdk21) gradleArgs.push(`-Porg.gradle.java.installations.paths=${jdk21}`);
gradleArgs.push('-Porg.gradle.java.installations.auto-download=false');

const wrapper = join(ANDROID_DIR, isWin ? 'gradlew.bat' : 'gradlew');
if (!existsSync(wrapper)) fail('Нет android/gradlew — выполните `npx cap add android`.');

function gradlew(args, label) {
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    step(`${label}  (попытка ${attempt}/${RETRIES})`);
    if (run(wrapper, args, { cwd: ANDROID_DIR, env }).status === 0) return true;
    if (attempt < RETRIES) {
      warn(`не прошло — сеть периодически рвёт TLS; повтор через 5 с`);
      sleep(5000);
    }
  }
  return false;
}

// ------------------------------------------------- веб-ассеты и cap sync
/**
 * Свежесть `dist/index.html` относительно исходников.
 *
 * Раньше скрипт смотрел только на существование файла: если `dist/` был,
 * сборка брала его как есть. Но `dist/` мог быть от предыдущей правки — и
 * тогда APK уезжал в релиз с чужим бандлом, в то время как установщик
 * Windows собирался из свежего. Проверка хэша ниже этого не ловила: она
 * сравнивает `dist/` с его копией в ассетах, а обе были устаревшими
 * одинаково. Расхождение обнаружилось только сверкой трёх сборок вручную.
 *
 * Поэтому сравниваем время: бандл должен быть не старше самой свежей
 * правки исходников.
 */
const newestSource = (() => {
  const sources = [
    join(ROOT, 'index.html'),
    join(ROOT, 'vite.config.ts'),
    join(ROOT, 'vite.shared.ts'),
    join(ROOT, 'vite.dev.config.ts'),
    join(ROOT, 'package.json'),
    // license.txt подключается в бандл как строка (license.txt?raw в
    // src/lib/license.ts), поэтому он такой же исходник, как и код: правка
    // условий обязана пересобирать сборку. Без него в релиз уехал бы APK со
    // старым текстом, а в этом тексте — запрет распространения.
    join(ROOT, 'license.txt'),
  ];
  let newest = 0;
  let newestName = '';
  const consider = (file) => {
    if (!existsSync(file)) return;
    const m = statSync(file).mtimeMs;
    if (m > newest) {
      newest = m;
      newestName = file;
    }
  };
  for (const file of sources) consider(file);
  // Рекурсивно по исходникам и картинкам: каталогов немного, а список
  // вручную однажды разойдётся с реальностью.
  for (const dir of [join(ROOT, 'src'), join(ROOT, 'public')]) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      consider(join(entry.parentPath ?? entry.path, entry.name));
    }
  }
  return { mtime: newest, name: newestName };
})();

const distIndex = join(ROOT, 'dist', 'index.html');
const distStale = !existsSync(distIndex) || statSync(distIndex).mtimeMs < newestSource.mtime;

if (!existsSync(distIndex)) {
  if (!DO_WEB) fail('Нет dist/index.html. Сначала `npm run build` (или запустите с --with-web).');
  step('dist/ отсутствует -> npm run build');
  if (run(isWin ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: ROOT }).status !== 0) fail('`npm run build` завершился с ошибкой.');
} else if (distStale) {
  // Молча брать устаревший бандл нельзя: выше уже случалось, что APK и
  // установщик Windows собирались из разного кода, и заметил это только
  // ручной сверкой трёх сборок. Пересобираем сами, ключ --with-web для
  // этого не нужен.
  const rel = (p) => (p ? relative(ROOT, p) : '?');
  step(c.y(`dist/index.html старее исходников (последняя правка: ${rel(newestSource.name)}) -> npm run build`));
  if (run(isWin ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: ROOT }).status !== 0) fail('`npm run build` завершился с ошибкой.');
} else {
  step('dist/index.html свежее исходников — пересборка вёрстки не нужна');
}

if (DO_SYNC) {
  step('npx cap sync android   (dist/ -> android/app/src/main/assets/public)');
  if (run(isWin ? 'npx.cmd' : 'npx', ['cap', 'sync', 'android'], { cwd: ROOT }).status !== 0) fail('`npx cap sync android` завершился с ошибкой.');

  // Сверяем не размер, а хэш: одинаковый размер у разного содержимого
  // встречается (правка комментария или порядка импортов меняет бандл на
  // несколько байт), и такой APK уехал бы в релиз незамеченным.
  const srcPath = join(ROOT, 'dist', 'index.html');
  const dstPath = join(ANDROID_DIR, 'app', 'src', 'main', 'assets', 'public', 'index.html');
  if (!existsSync(dstPath)) fail('assets/public/index.html не появился — cap sync отработал не полностью.');
  const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const srcHash = digest(srcPath);
  const dstHash = digest(dstPath);
  if (srcHash !== dstHash) {
    fail(
      `Содержимое разошлось:\n` +
      `    dist/index.html          sha256 ${srcHash}\n` +
      `    assets/public/index.html sha256 ${dstHash}\n` +
      `  Значит cap sync отработал не полностью. Пересоберите с ключом --no-sync выключенным.`,
    );
  }
  step(c.g(`assets/public/index.html = ${statSync(dstPath).size.toLocaleString('ru')} байт, sha256 совпадает с dist/`));
}

if (DO_ICONS) {
  if (!isWin) {
    warn('Конвертер иконок написан под Windows (System.Drawing) — пропускаю.');
  } else {
    step('scripts/build-android-icons.ps1   (public/favicon.ico -> res/mipmap-*)');
    const ps = join(ROOT, 'scripts', 'build-android-icons.ps1');
    if (run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps], { cwd: ROOT }).status !== 0) {
      warn('Скрипт иконок отработал с ошибкой — собираю со старыми иконками.');
    }
  }
}

if (DO_CLEAN) {
  step('gradlew clean');
  run(wrapper, ['clean', ...gradleArgs], { cwd: ANDROID_DIR, env, quiet: true });
}

// ------------------------------------------------------------------ сборка
log();
const built = [];

if (DO_DEBUG) {
  if (!gradlew([':app:assembleDebug', ...gradleArgs], 'gradlew :app:assembleDebug')) fail('debug-сборка не удалась даже после повторов.');
  built.push(join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'));
}
if (DO_RELEASE) {
  if (!existsSync(join(ANDROID_DIR, 'keystore.properties'))) {
    fail('Нет android/keystore.properties — release нечем подписать. См. комментарий в этом файле.');
  }
  if (!gradlew([':app:assembleRelease', ...gradleArgs], 'gradlew :app:assembleRelease')) fail('release-сборка не удалась даже после повторов.');
  built.push(join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'));
}

// ------------------------------------------------------------------- отчёт
const aapt2 = findAapt2(sdk.dir);
log();
for (const apk of built) {
  if (!existsSync(apk)) { log(c.r(`  НЕ НАЙДЕН: ${apk}`)); continue; }
  const size = statSync(apk).size;
  log(c.b(`  ${basename(apk)}`));
  log(`    путь  : ${apk}`);
  log(`    размер: ${size.toLocaleString('ru')} байт (${(size / 1048576).toFixed(2)} МБ)`);
  if (aapt2) {
    for (const l of capture(aapt2, ['dump', 'badging', apk]).split(/\r?\n/)) {
      if (/^(package:|application-label:|sdkVersion:|targetSdkVersion:|uses-permission:)/.test(l)) log(c.d(`    ${l.trim()}`));
    }
  }
  log();
}

log(c.g('Готово. APK:'));
for (const apk of built) if (existsSync(apk)) log(`  ${apk}`);
log();
