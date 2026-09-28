// src/lib/license.ts
// Разбор условий использования из license.txt в блоки для показа.
//
// Почему разбор здесь, а не в компоненте: текст условий — главное
// требование к программе (запрет распространения), и он не должен
// молча испортиться при первом же изменении формата. Разбор вынесен в
// модуль без React, чтобы его можно было проверить тестом: `tests/license.test.ts`
// проверяет и структуру, и наличие ключевых формулировок.
//
// Структура файла намеренно плоская: строка-заголовок раздела с номером,
// под ней линия из тире, дальше текст с маркерами `*`. Сложный парсер
// (AST, markdown) здесь был бы лишним: при незнакомой строке он молча
// сломал бы показ, а этот разбор покажет её обычным текстом.
import licenseText from "../../license.txt?raw";

/** Разобранный блок условий. */
export type LicenseBlock =
  | { kind: "header"; lines: string[] }
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string }
  | { kind: "item"; text: string };

const HEADING = /^(\d+)\.\s+(\S.*)$/;
const RULE = /^[-=]{3,}\s*$/;
const ITEM = /^\s*\*\s+(.*)$/;
// Строка с отступом, но без маркера, — это продолжение предыдущего пункта
// или абзаца. В файле текст жёстко обёрнут по 70 символов, и без этого
// правила длинный пункт распадался на маркированную строку и отдельный
// абзац: на экране это выглядит как сломанный список.
const CONTINUATION = /^[ \t]+\S/;

export const parseLicense = (source: string): LicenseBlock[] => {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: LicenseBlock[] = [];
  const header: string[] = [];
  let para: string[] = [];
  // Шапка — это всё до первого заголовка раздела. Нужен флаг, а не
  // отдельный режим разбора: пока флаг сброшен, обычная строка попадает в
  // шапку, а не в текст.
  let seenHeading = false;

  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push({ kind: "para", text: para.join(" ") });
    para = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = HEADING.exec(line);

    if (heading && RULE.test(lines[i + 1] ?? "")) {
      // Первый заголовок закрывает шапку, иначе она уехала бы в конец.
      if (!seenHeading) {
        seenHeading = true;
        if (header.length > 0) blocks.push({ kind: "header", lines: header.splice(0) });
      }
      flushPara();
      blocks.push({ kind: "heading", text: `${heading[1]}. ${heading[2]}` });
      i += 1;
      continue;
    }
    if (RULE.test(line)) continue;

    const item = ITEM.exec(line);
    if (item) {
      flushPara();
      blocks.push({ kind: "item", text: item[1] });
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      continue;
    }
    // Продолжение предыдущего блока: присоединяем к нему, а не начинаем
    // новый. Иначе перенос строки в файле превращается в разрыв текста,
    // и длинный пункт выглядит как два обрыва.
    if (CONTINUATION.test(line) && para.length === 0 && blocks.length > 0) {
      const last = blocks[blocks.length - 1];
      if (last.kind === "item" || last.kind === "para") {
        last.text = `${last.text} ${line.trim()}`;
        continue;
      }
    }
    if (!seenHeading) {
      header.push(line.trim());
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  // Файл без разделов: всё содержимое — шапка, и показывать его надо.
  if (header.length > 0) blocks.push({ kind: "header", lines: header });
  return blocks;
};

/** Условия целиком, строкой — так их же копирует пользователь. */
export const LICENSE_PLAIN = licenseText;

/** Готовые блоки для показа: разбор выполняется один раз при загрузке. */
export const LICENSE_BLOCKS = parseLicense(licenseText);
