// src/components/LicenseDialog.tsx
// Показ условий использования внутри программы.
//
// Почему условия показываются здесь, а не на странице установщика: в сборке
// нет ни ключей активации, ни проверки лицензии, и на этапе беты их не
// предвидится. Страница лицензии в установщике NSIS ничего не проверяет, а
// показывает текст до установки — то есть человек видит его один раз и,
// скорее всего, не читает. Внутри программы условия всегда доступны, и
// главное из них — запрет распространения — читается уже после установки.
//
// Текст берётся из license.txt в корне репозитория (`?raw`), поэтому он
// существует в один экземпляр: тот же файл открывает человек, его читает
// документация и на него ссылаются условия об отзыве. Вторая копия текста
// в src/ рано или поздно разошлась бы с ним, и запрет распространения
// оказался бы в одном месте есть, а в другом нет.
import { useState } from "react";
import { ScrollText } from "lucide-react";
import { LICENSE_BLOCKS } from "../lib/license";
import { Modal } from "./ui";

export function LicenseText() {
  return (
    <div
      className="license-text"
      style={{ maxHeight: "min(62vh, 640px)", overflowY: "auto" }}
    >
      {LICENSE_BLOCKS.map((block, index) => {
        if (block.kind === "header") {
          return (
            <div key={index} className="mb-4">
              {block.lines.map((line, i) => (
                <p
                  key={i}
                  className={i === 0 ? "font-semibold" : "text-xs"}
                  style={{ color: i === 0 ? "var(--text)" : "var(--muted)" }}
                >
                  {line}
                </p>
              ))}
            </div>
          );
        }
        if (block.kind === "heading") {
          return (
            <h3 key={index} className="text-sm font-semibold mt-5 mb-1.5">
              {block.text}
            </h3>
          );
        }
        if (block.kind === "item") {
          return (
            <p
              key={index}
              className="text-sm"
              style={{ color: "var(--muted)", paddingLeft: "1em", textIndent: "-1em" }}
            >
              {"• " + block.text}
            </p>
          );
        }
        return (
          <p key={index} className="text-sm mb-2" style={{ color: "var(--muted)" }}>
            {block.text}
          </p>
        );
      })}
    </div>
  );
}

/**
 * Кнопка-ссылка на условия вместе с окном. Состояние держит сам
 * компонент, поэтому его можно поставить в любое место — в настройки и в
 * футер — без поднятия состояния через всё дерево.
 */
export function LicenseLink({
  className = "footer-link",
  label = "Условия",
}: {
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => setOpen(true)}
        title="Условия использования программы"
      >
        <ScrollText size={14} aria-hidden /> {label}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Условия использования" wide>
        <LicenseText />
      </Modal>
    </>
  );
}
