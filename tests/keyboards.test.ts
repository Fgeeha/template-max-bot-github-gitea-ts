/** Проверки payload'ов и сборки клавиатур. */
import { describe, expect, it } from "vitest";
import {
  BackPayload,
  MAX_PAYLOAD_LEN,
  MenuPayload,
  PayloadError,
} from "../src/keyboards/callbacks.js";
import { getSection, mainMenu, SECTIONS } from "../src/keyboards/menus.js";

describe("keyboards", () => {
  it("payload меню собирается и разбирается обратно", () => {
    const packed = new MenuPayload("about").pack();
    expect(MenuPayload.unpack(packed).section).toBe("about");
  });

  it("отклоняет чужой префикс", () => {
    expect(() => MenuPayload.unpack("back")).toThrow(PayloadError);
  });

  it("отклоняет пустой раздел", () => {
    expect(() => MenuPayload.unpack("menu:")).toThrow(PayloadError);
  });

  it("отклоняет слишком длинный payload", () => {
    expect(() => new MenuPayload("x".repeat(MAX_PAYLOAD_LEN)).pack()).toThrow(PayloadError);
  });

  it("payload возврата совпадает только сам с собой", () => {
    expect(BackPayload.matches(new BackPayload().pack())).toBe(true);
    expect(MenuPayload.matches(new BackPayload().pack())).toBe(false);
  });

  it("все разделы имеют уникальные id", () => {
    const ids = SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("каждая callback-кнопка меню ведёт в существующий раздел", () => {
    for (const section of SECTIONS) {
      if (section.url) continue;
      const packed = new MenuPayload(section.id).pack();
      expect(getSection(MenuPayload.unpack(packed).section)).toBeDefined();
    }
  });

  it("главное меню собирается", () => {
    expect(mainMenu().asMarkup()).toBeDefined();
  });
});
