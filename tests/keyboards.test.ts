/** Проверки payload'ов и сборки клавиатур. */
import { describe, expect, it } from "vitest";
import type { Section } from "../src/db/models.js";
import {
  AdminAction,
  AdminPayload,
  MAX_PAYLOAD_LEN,
  PayloadError,
  SectionPayload,
} from "../src/keyboards/callbacks.js";
import { adminKeyboard, MAX_CHILDREN, sectionKeyboard } from "../src/keyboards/menus.js";

const section = (id: number, parentId: number | null, extra: Partial<Section> = {}): Section => ({
  id,
  parentId,
  title: `Раздел ${id}`,
  text: "",
  position: 0,
  url: null,
  imageToken: null,
  ...extra,
});

const labels = (markup: ReturnType<typeof adminKeyboard>) =>
  markup.payload.buttons.flat().map((b) => b.text);

describe("payload'ы", () => {
  it("payload раздела собирается и разбирается обратно", () => {
    expect(SectionPayload.unpack(new SectionPayload(42).pack()).sectionId).toBe(42);
  });

  it.each(["s:", "s:abc", "s:-1", "x:1", "s:1:2", "menu:about"])(
    "payload раздела %s отклоняется",
    (raw) => {
      expect(() => SectionPayload.unpack(raw)).toThrow(PayloadError);
    },
  );

  it.each(Object.values(AdminAction))("payload админки «%s» собирается и разбирается", (action) => {
    const payload = AdminPayload.unpack(new AdminPayload(action, 7).pack());
    expect(payload).toEqual(new AdminPayload(action, 7));
  });

  it.each(["a:open", "a:nope:1", "a:open:x", "s:1", "a:open:1:2"])(
    "payload админки %s отклоняется",
    (raw) => {
      expect(() => AdminPayload.unpack(raw)).toThrow(PayloadError);
    },
  );

  it("префиксы не пересекаются", () => {
    expect(AdminPayload.matches(new SectionPayload(1).pack())).toBe(false);
    expect(() => SectionPayload.unpack(new AdminPayload(AdminAction.Open, 1).pack())).toThrow(
      PayloadError,
    );
  });

  it("самый длинный payload админки укладывается в лимит", () => {
    const packed = new AdminPayload(AdminAction.StaffDelConfirm, Number.MAX_SAFE_INTEGER).pack();
    expect(packed.length).toBeLessThanOrEqual(MAX_PAYLOAD_LEN);
  });
});

describe("клавиатуры", () => {
  it("у главного меню без подразделов клавиатуры нет", () => {
    expect(sectionKeyboard(section(1, null), [])).toBeUndefined();
  });

  it("у главного меню в админке нет «Удалить», «Ссылка» и «Назад»", () => {
    const names = labels(adminKeyboard(section(1, null), []));
    expect(names).not.toContain("🗑 Удалить");
    expect(names).not.toContain("🔗 Ссылка");
    expect(names).not.toContain("◀️ Назад");
    expect(names).toContain("👥 Админы");
  });

  it.each([null, 1])("экран админки при %s родителе укладывается в 30 рядов MAX", (parentId) => {
    const children = Array.from({ length: MAX_CHILDREN }, (_, i) => section(i + 10, 2));
    const rows = adminKeyboard(section(2, parentId), children).payload.buttons;
    expect(rows.length).toBeLessThanOrEqual(30);
  });

  it("подпись раздела-ссылки в админке не длиннее 64 символов", () => {
    const child = section(5, 1, { title: "я".repeat(64), url: "https://example.ru" });
    const first = adminKeyboard(section(1, null), [child]).payload.buttons[0]?.[0];
    expect([...(first?.text ?? "")].length).toBe(64);
  });
});
