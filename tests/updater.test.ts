// tests/updater.test.ts
// Что проверяем: разбор ответа GitHub Releases API, по которому Android и
// веб-режим решают, есть ли обновление. Здесь важна не арифметика, а три
// правила, каждое из которых уже ломало проверку:
//
//   1. берётся СПИСОК релизов, а не `/releases/latest` — последний не
//      возвращает предварительные релизы, а все наши беты помечены
//      prerelease, поэтому такой запрос отвечал бы 404 всегда;
//   2. черновики не считаются релизом;
//   3. «последний» — это самый свежий по дате публикации, а не первый в
//      ответе: порядок GitHub не объявляет гарантией.
import { describe, expect, it } from "vitest";
import {
  isBetaVersion,
  isNewerVersion,
  pickLatestRelease,
  RELEASES_API_URL,
  type ReleaseEntry,
} from "../src/lib/updater";

const release = (over: Partial<ReleaseEntry> = {}): ReleaseEntry => ({
  tag_name: "v1.0.0-beta.1",
  body: "Что нового",
  html_url: "https://github.com/dev-aitechpro/nexus-finance-beta/releases/tag/v1.0.0-beta.1",
  draft: false,
  published_at: "2026-09-28T07:31:54Z",
  ...over,
});

describe("выбор последнего релиза", () => {
  it("берёт последний из списка и убирает ведущий v из версии", () => {
    const result = pickLatestRelease([
      release({ tag_name: "v1.0.0-beta.1", published_at: "2026-09-01T00:00:00Z" }),
      release({ tag_name: "v1.0.0-beta.2", published_at: "2026-09-20T00:00:00Z" }),
    ]);
    expect(result?.version).toBe("1.0.0-beta.2");
  });

  it("не полагается на порядок в ответе: более свежий выбирается из середины", () => {
    // Именно такой ответ может вернуть GitHub: позиция в массиве не значит
    // ничего, если сортировать по published_at.
    const result = pickLatestRelease([
      release({ tag_name: "v1.0.0-beta.1", published_at: "2026-09-01T00:00:00Z" }),
      release({ tag_name: "v1.0.0-beta.3", published_at: "2026-10-05T00:00:00Z" }),
      release({ tag_name: "v1.0.0-beta.2", published_at: "2026-09-20T00:00:00Z" }),
    ]);
    expect(result?.version).toBe("1.0.0-beta.3");
  });

  it("пропускает черновик, даже если он новее всех", () => {
    // Черновик не виден по прямой ссылке даже автору: предлагать пользователю
    // «новую версию», которой нельзя скачать, нельзя.
    const result = pickLatestRelease([
      release({ tag_name: "v1.0.0-beta.9", draft: true, published_at: "2026-12-31T00:00:00Z" }),
      release({ tag_name: "v1.0.0-beta.2", published_at: "2026-09-20T00:00:00Z" }),
    ]);
    expect(result?.version).toBe("1.0.0-beta.2");
  });

  it("null, если опубликованных релизов нет — это «обновлений нет», а не ошибка", () => {
    expect(pickLatestRelease([])).toBeNull();
    expect(pickLatestRelease([release({ draft: true })])).toBeNull();
  });

  it("переживает одиночный объект вместо списка", () => {
    // Смена формата ответа не должна превращаться в падение: показываем
    // пользователю сообщение об ошибке вместо ответа.
    expect(pickLatestRelease(release({ tag_name: "v1.0.0-beta.7" }))?.version).toBe("1.0.0-beta.7");
  });

  it("не доверяет мусору в ответе", () => {
    expect(pickLatestRelease([{ tag_name: "" }, {}, null, 42])).toBeNull();
  });

  it("подставляет страницу релиза, если GitHub не прислал ссылку", () => {
    const result = pickLatestRelease([release({ html_url: undefined })]);
    expect(result?.url).toMatch(/^https:\/\/github\.com\/.+\/releases\/latest$/);
  });

  it("пустые заметки превращаются в null, а не в пустую строку", () => {
    // Иначе интерфейс покажет пустой блок «Что нового».
    expect(pickLatestRelease([release({ body: "   \n " })])?.notes).toBeNull();
  });
});

describe("сравнение версий", () => {
  it("бета новее предыдущей беты, но старее финальной", () => {
    expect(isNewerVersion("1.0.0-beta.2", "1.0.0-beta.1")).toBe(true);
    expect(isNewerVersion("1.0.0-beta.1", "1.0.0-beta.1")).toBe(false);
    expect(isNewerVersion("1.0.0-beta.1", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0-beta.10", "1.0.0-beta.9")).toBe(true);
  });

  it("пре-суффикс распознаётся как бета", () => {
    expect(isBetaVersion("1.0.0-beta.1")).toBe(true);
    expect(isBetaVersion("1.0.0")).toBe(false);
  });
});

describe("адрес API обновлений", () => {
  it("берётся список релизов, а не /releases/latest", () => {
    // /releases/latest не возвращает prerelease — на бете это всегда 404.
    expect(RELEASES_API_URL).toContain("/releases?");
    expect(RELEASES_API_URL).not.toContain("/releases/latest");
  });
});
