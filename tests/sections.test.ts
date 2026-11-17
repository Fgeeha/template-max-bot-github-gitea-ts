/** Репозиторий дерева разделов, отрисовка экрана и проверки ввода админки. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Section } from "../src/db/models.js";
import { withTransaction } from "../src/db/pool.js";
import { SectionRepository } from "../src/db/repositories/sections.js";
import { userHash } from "../src/db/repositories/stats.js";
import { parseLink, TEXT_MAX_LEN, validateText, validateTitle } from "../src/handlers/inputs.js";
import { loadRoot, renderSection } from "../src/handlers/menu.js";
import { localTime } from "../src/handlers/tools.js";
import { BACK_TEXT } from "../src/keyboards/menus.js";
import { resetDb } from "./helpers/db.js";
import { withEnv } from "./helpers/env.js";

vi.mock("../src/db/pool.js", () => import("./helpers/db.js").then((m) => m.poolMock));

const repo = <T>(fn: (r: SectionRepository) => Promise<T>) =>
  withTransaction((db) => fn(new SectionRepository(db)));

beforeEach(async () => {
  withEnv();
  await resetDb();
});

describe("SectionRepository", () => {
  it("корень создаётся один раз", async () => {
    const first = await repo((r) => r.root());
    const second = await repo((r) => r.root());
    expect(second.id).toBe(first.id);
  });

  it("подразделы добавляются по порядку", async () => {
    const titles = await repo(async (r) => {
      const root = await r.root();
      for (const title of ["а", "б", "в"]) await r.add(root.id, title);
      return (await r.children(root.id)).map((s) => s.title);
    });
    expect(titles).toEqual(["а", "б", "в"]);
  });

  it("двигает вверх и вниз, крайний не двигается", async () => {
    const order = await repo(async (r) => {
      const root = await r.root();
      const [a, , c] = [
        await r.add(root.id, "а"),
        await r.add(root.id, "б"),
        await r.add(root.id, "в"),
      ];
      expect(await r.move(c as Section, -1)).toBe(true);
      expect(await r.move(a as Section, -1)).toBe(false);
      expect(await r.move((await r.get((c as Section).id)) as Section, 1)).toBe(true);
      return (await r.children(root.id)).map((s) => s.title);
    });
    expect(order).toEqual(["а", "б", "в"]);
  });

  it("удаление уносит всю ветку", async () => {
    const left = await repo(async (r) => {
      const root = await r.root();
      const branch = await r.add(root.id, "ветка");
      const leaf = await r.add(branch.id, "лист");
      await r.add(leaf.id, "лист 2");
      expect(await r.countDescendants(branch.id)).toBe(2);
      await r.delete(branch.id);
      return r.get(leaf.id);
    });
    expect(left).toBeUndefined();
  });

  it("путь — от корня до раздела", async () => {
    const path = await repo(async (r) => {
      const root = await r.root();
      const leaf = await r.add((await r.add(root.id, "раздел")).id, "лист");
      return (await r.path(leaf)).map((s) => s.title);
    });
    expect(path).toEqual(["Главное меню", "раздел", "лист"]);
  });

  it("миграция кладёт демо-разделы: приветствие и кнопки меню", async () => {
    await resetDb(true);
    const screen = await loadRoot();
    expect(screen.text).toContain("Здравствуйте");
    const keyboard = screen.attachments.find((a) => a.type === "inline_keyboard");
    const names =
      keyboard?.type === "inline_keyboard"
        ? keyboard.payload.buttons.flat().map((b) => b.text)
        : [];
    expect(names).toEqual(["ℹ️ О нас", "📞 Контакты", "❓ Помощь", "🌐 Сайт"]);
    // id сида не заданы явно — следующая вставка не упирается в sequence.
    await repo(async (r) => r.add((await r.root()).id, "новый"));
  });
});

const make = (extra: Partial<Section>): Section => ({
  id: 2,
  parentId: 1,
  title: "Раздел",
  text: "",
  position: 0,
  url: null,
  imageToken: null,
  ...extra,
});

describe("renderSection", () => {
  it("лист — текст и одна кнопка «Назад»", () => {
    const screen = renderSection(make({ text: "текст" }), []);
    expect(screen.text).toBe("текст");
    const keyboard = screen.attachments[0];
    expect(
      keyboard?.type === "inline_keyboard" && keyboard.payload.buttons.flat().map((b) => b.text),
    ).toEqual([BACK_TEXT]);
  });

  it("без текста показывается название", () => {
    expect(renderSection(make({ text: "  " }), []).text).toBe("Раздел");
  });

  it("подраздел-ссылка — link-кнопка", () => {
    const child = make({ id: 3, parentId: 2, title: "Сайт", url: "https://max.ru" });
    const keyboard = renderSection(make({ text: "т" }), [child]).attachments[0];
    expect(keyboard?.type === "inline_keyboard" && keyboard.payload.buttons[0]?.[0]).toMatchObject({
      type: "link",
      url: "https://max.ru",
    });
  });

  it("картинка идёт над клавиатурой", () => {
    const types = renderSection(make({ text: "т", imageToken: "tok" }), []).attachments.map(
      (a) => a.type,
    );
    expect(types).toEqual(["image", "inline_keyboard"]);
  });
});

describe("проверки ввода", () => {
  it("название и текст", () => {
    expect(validateTitle("")).toContain("пустым");
    expect(validateTitle("ок")).toBeUndefined();
    expect(validateText("x".repeat(TEXT_MAX_LEN))).toBeUndefined();
    expect(validateText("x".repeat(TEXT_MAX_LEN + 1))).toContain("длиннее");
  });

  it.each(["https://example.ru", "http://example.ru/path?q=1#x", "https://sub.example.ru:8443/a"])(
    "годная ссылка %s",
    (url) => {
      expect(parseLink(url).error).toBeUndefined();
    },
  );

  it.each([
    "example.ru",
    "ftp://example.ru",
    "javascript:alert(1)",
    "https://localhost",
    "https://user:pass@example.ru",
    "https://exa mple.ru",
    "https://example.ru/\u0000",
    "http://[",
    `https://example.ru/${"a".repeat(2048)}`,
  ])("негодная ссылка %s", (url) => {
    expect(parseLink(url).error).toBeDefined();
  });

  it("кириллический домен переводится в punycode", () => {
    expect(parseLink("https://пример.рф/путь").value).toBe(
      "https://xn--e1afmkfd.xn--p1ai/%D0%BF%D1%83%D1%82%D1%8C",
    );
  });
});

describe("служебное", () => {
  it("хеш посетителя стабилен, зависит от соли и не содержит id", () => {
    expect(userHash(123, "salt")).toBe(userHash(123, "salt"));
    expect(userHash(123, "salt")).not.toBe(userHash(123, "other"));
    expect(userHash(123, "salt")).toHaveLength(32);
  });

  it("время в админке — со смещением DISPLAY_UTC_OFFSET", () => {
    withEnv({ DISPLAY_UTC_OFFSET: "3" });
    const moment = new Date("2026-01-31T22:30:00Z");
    expect(localTime(moment)).toBe("01.02 01:30");
    expect(localTime(moment, true)).toBe("01.02.2026");
  });
});
