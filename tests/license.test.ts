// tests/license.test.ts
// Что проверяем: условия использования не должны молча испортиться.
//
// Текст условий — главное требование к программе, и в нём есть формулировки,
// без которых программа теряет смысл: запрет распространения и «вправе только
// автор». Обычный тест их не поймает: разбор текста может отработать неверно
// (заголовки не распознаются, пункты слипаются), и на экране будет тихо
// не то. Поэтому проверяем и структуру разбора, и наличие ключевых слов в
// готовом тексте.
//
// Здесь же проверка на «текст вообще показывается»: пустой или состоящий из
// одного заголовка разбор — это не ошибка сборки, но условий фактически нет.
import { describe, expect, it } from "vitest";
import { LICENSE_BLOCKS, LICENSE_PLAIN, parseLicense } from "../src/lib/license";

describe("разбор условий", () => {
  it("находит все разделы и ни одного лишнего заголовка", () => {
    // Номера разделов в файле идут подряд: если разбор начал цеплять
    // обычные строки за заголовки, их число разошлось бы с содержанием.
    const headings = LICENSE_BLOCKS.filter((b) => b.kind === "heading");
    expect(headings.length).toBeGreaterThanOrEqual(8);
    const numbers = headings.map((h) => Number(/^(\d+)\./.exec((h as { text: string }).text)?.[1]));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(numbers[0]).toBe(1);
  });

  it("заголовок раздела не содержит подчёркивания из линии под ним", () => {
    for (const block of LICENSE_BLOCKS) {
      if (block.kind !== "heading") continue;
      expect(block.text).not.toMatch(/[-=]{3}/);
    }
  });

  it("первые строки файла идут в шапку, а не в текст", () => {
    expect(LICENSE_BLOCKS[0]?.kind).toBe("header");
  });

  it("маркированные пункты остаются пунктами, а не абзацами", () => {
    const items = LICENSE_BLOCKS.filter((b) => b.kind === "item");
    expect(items.length).toBeGreaterThan(5);
    for (const item of items) {
      if (item.kind !== "item") continue;
      // Исходный маркер «* » не должен попасть в текст пункта.
      expect(item.text.startsWith("*")).toBe(false);
    }
  });

  it("переносы строк внутри абзаца склеиваются в один абзац", () => {
    // Текст написан вручную и жёстко обёрнут по 70 символов: если бы
    // разбор не склеивал строки, на экране был бы рваный список фрагментов
    // вместо читаемых абзацев.
    const paras = LICENSE_BLOCKS.filter((b) => b.kind === "para");
    expect(paras.length).toBeGreaterThan(3);
    for (const para of paras) {
      if (para.kind !== "para") continue;
      expect(para.text).not.toMatch(/\n/);
    }
  });

  it("перенос внутри пункта не превращается в отдельный абзац", () => {
    // Реальный случай в условиях: пункт про запрет распространения
    // обёрнут на двух строках. Без склейки на экране получалось «• текст
    // до запятой», а ниже отдельным абзацем «в файлообменники, …» — то
    // есть список выглядел сломанным.
    const items = LICENSE_BLOCKS.filter((b) => b.kind === "item").map((b) => (b as { text: string }).text);
    const long = items.find((t) => t.startsWith("выкладывать установщик или APK"));
    expect(long).toBeDefined();
    expect(long).toContain("в файлообменники");
    // И второй такой же многострочный пункт — про обход условия.
    const bypass = items.find((t) => t.startsWith("обходить это условие"));
    expect(bypass).toContain("любым другим способом");
  });

  it("в условиях нет пункта, оборванного на середине фразы", () => {
    // Признак обрыва: пункт заканчивается запятой, а следующий блок —
    // абзац. Так выглядит текст, у которого не отработала склейка строк.
    for (let i = 0; i < LICENSE_BLOCKS.length - 1; i += 1) {
      const current = LICENSE_BLOCKS[i];
      const next = LICENSE_BLOCKS[i + 1];
      if (current.kind !== "item" || next.kind !== "para") continue;
      expect(current.text.trimEnd().endsWith(",")).toBe(false);
      expect(current.text.trimEnd().endsWith("—")).toBe(false);
    }
  });

  it("контакты в условиях остаются отдельными пунктами", () => {
    // Четыре строки контактов подряд без маркеров слиплись бы в один
    // абзац, где ссылки не отделены друг от друга.
    const contact = LICENSE_BLOCKS.filter(
      (b) => b.kind === "item" && /https?:\/\//.test(b.text),
    );
    expect(contact.length).toBeGreaterThanOrEqual(3);
  });

  it("пустой или незнакомый текст не роняет разбор", () => {
    expect(parseLicense("")).toEqual([]);
    expect(parseLicense("просто строка без разделов")).toEqual([
      { kind: "header", lines: ["просто строка без разделов"] },
    ]);
  });

  it("отступ без маркера присоединяется к предыдущему блоку", () => {
    const blocks = parseLicense(
      [
        "ЗАГОЛОВОК",
        "========",
        "1. РАЗДЕЛ",
        "-------",
        "Абзац из двух",
        "строк.",
        "",
        "  * пункт из",
        "    двух строк",
        "",
        "хвост абзаца",
      ].join("\n"),
    );
    expect(blocks).toEqual([
      { kind: "header", lines: ["ЗАГОЛОВОК"] },
      { kind: "heading", text: "1. РАЗДЕЛ" },
      { kind: "para", text: "Абзац из двух строк." },
      { kind: "item", text: "пункт из двух строк" },
      { kind: "para", text: "хвост абзаца" },
    ]);
  });
});

describe("содержание условий", () => {
  it("запрет распространения — главное, и он на месте", () => {
    // Если эти формулировки исчезнут, программа перестанет запрещать то,
    // ради чего условия существуют. Проверка специально на слова, а не на
    // смысл: смысл машина не проверит, а слова — да.
    expect(LICENSE_PLAIN).toMatch(/РАСПРОСТРАНЕНИЕ ЗАПРЕЩЕНО/);
    expect(LICENSE_PLAIN).toMatch(/распространять эту программу вправе\s+только автор/);
    expect(LICENSE_PLAIN).toMatch(/независимо от оплаты/i);
  });

  it("в тексте нет утверждения, что лицензия на код выдаётся", () => {
    expect(LICENSE_PLAIN).not.toMatch(/MIT/i);
    expect(LICENSE_PLAIN).not.toMatch(/Apache|GPL|BSD/i);
  });

  it("сказано, что проверки лицензии нет, и это ничего не разрешает", () => {
    // Иначе читатель решит, что запрет можно обойти: «ну ключа же нет».
    expect(LICENSE_PLAIN).toMatch(/нет ключей активации/);
    expect(LICENSE_PLAIN).toMatch(/её отсутствие ничего не\s+разрешает/);
  });
});
