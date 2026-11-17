/** Сценарий админки целиком: добавить раздел, задать текст, увидеть, удалить. */
import { MaxError } from "@maxhub/max-bot-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTransaction } from "../src/db/pool.js";
import { SectionRepository } from "../src/db/repositories/sections.js";
import { CLEAR, TITLE_MAX_LEN } from "../src/handlers/inputs.js";
import { STALE_TEXT } from "../src/handlers/menu.js";
import { waiting } from "../src/handlers/pending.js";
import { AdminAction, AdminPayload, SectionPayload } from "../src/keyboards/callbacks.js";
import { BACK_TEXT, MAX_CHILDREN } from "../src/keyboards/menus.js";
import {
  ADMIN,
  buttons,
  FakeApi,
  press,
  resetPending,
  STRANGER,
  send,
  tap,
} from "./helpers/bot.js";
import { resetDb } from "./helpers/db.js";
import { withEnv } from "./helpers/env.js";

vi.mock("../src/db/pool.js", () => import("./helpers/db.js").then((m) => m.poolMock));

const ROOT_TEXT = "Выберите раздел 👇";

beforeEach(async () => {
  withEnv({ ADMIN_IDS: String(ADMIN) });
  resetPending();
  await resetDb();
});

/** Добавляет раздел в обход админки; text/url — сразу. */
async function addSection(
  title: string,
  fields: { text?: string; url?: string } = {},
  parent?: number,
) {
  return withTransaction(async (db) => {
    const repo = new SectionRepository(db);
    const section = await repo.add(parent ?? (await repo.root()).id, title);
    Object.assign(section, fields);
    await repo.save(section);
    return section;
  });
}

async function openAdmin() {
  return (await send(ADMIN, "/admin")).last;
}

describe("админка разделов", () => {
  it("админ собирает раздел, пользователь его видит, после удаления кнопка гаснет", async () => {
    const admin = await openAdmin();
    const ask = await press(ADMIN, tap(admin.attachments, "➕ Добавить подраздел"));
    expect(ask.last.text).toContain("название");
    const added = (await send(ADMIN, "Техосмотр")).last;
    expect(added.text).toContain("Подраздел добавлен");

    await press(ADMIN, tap(added.attachments, "📝 Текст"));
    const saved = (await send(ADMIN, "🛠️ Мототранспорт\nСтоимость ТО – 378 руб")).last;
    expect(saved.text).toContain("Текст сохранён");

    // Пользователь: главное меню → кнопка → текст с одной кнопкой «Назад».
    const root = (await send(STRANGER, "привет")).last;
    expect(root.text).toBe(ROOT_TEXT);
    const screen = await press(STRANGER, tap(root.attachments, "Техосмотр"));
    expect(screen.last.via).toBe("edit");
    expect(screen.last.text).toBe("🛠️ Мототранспорт\nСтоимость ТО – 378 руб");
    expect(Object.keys(buttons(screen.last.attachments))).toEqual([BACK_TEXT]);
    const back = await press(STRANGER, tap(screen.last.attachments, BACK_TEXT));
    expect(back.last.text).toBe(ROOT_TEXT);

    const confirm = await press(ADMIN, tap(saved.attachments, "🗑 Удалить"));
    const deleted = await press(ADMIN, tap(confirm.last.attachments, "✅ Да, удалить"));
    expect(deleted.notification).toBe("Раздел удалён");
    const stale = await press(STRANGER, tap(root.attachments, "Техосмотр"));
    expect(stale.notification).toBe(STALE_TEXT);
    expect(stale.last.text).toBe(ROOT_TEXT);
  });

  it("неверное название оставляет ожидание ввода", async () => {
    await press(ADMIN, tap((await openAdmin()).attachments, "➕ Добавить подраздел"));
    expect((await send(ADMIN, "x".repeat(TITLE_MAX_LEN + 1))).last.text.startsWith("⚠️")).toBe(true);
    expect((await send(ADMIN, "Тарифы")).last.text).toContain("Подраздел добавлен");
  });

  it("название считается в символах, а не в UTF-16", async () => {
    await press(ADMIN, tap((await openAdmin()).attachments, "➕ Добавить подраздел"));
    expect((await send(ADMIN, "🚗".repeat(TITLE_MAX_LEN))).last.text).toContain(
      "Подраздел добавлен",
    );
  });

  it("постороннему админка не отвечает", async () => {
    expect((await send(STRANGER, "/admin")).shown).toEqual([]);
    const api = await press(STRANGER, new AdminPayload(AdminAction.Add, 1).pack());
    expect(api.answers).toEqual([{ notification: "Недоступно" }]);
    expect(waiting.has(STRANGER)).toBe(false);
  });

  it("команда во время ожидания ввода — команда, а не название", async () => {
    await press(ADMIN, tap((await openAdmin()).attachments, "➕ Добавить подраздел"));
    const reply = await send(ADMIN, "/start");
    expect(reply.last.text).toBe(ROOT_TEXT);
    expect(waiting.has(ADMIN)).toBe(true);
  });

  it("реплика админа в группе не становится текстом раздела", async () => {
    await press(ADMIN, tap((await openAdmin()).attachments, "➕ Добавить подраздел"));
    const reply = await send(ADMIN, "всем привет", { chatType: "chat" });
    expect(reply.shown).toEqual([]);
    expect(waiting.has(ADMIN)).toBe(true);
  });

  it("лимит подразделов проверяется и при вводе названия", async () => {
    await press(ADMIN, tap((await openAdmin()).attachments, "➕ Добавить подраздел"));
    for (let i = 0; i < MAX_CHILDREN; i += 1) await addSection(`Раздел ${i}`);
    expect((await send(ADMIN, "Лишний")).last.text.startsWith("⚠️")).toBe(true);
    const count = await withTransaction(async (db) => {
      const repo = new SectionRepository(db);
      return (await repo.children((await repo.root()).id)).length;
    });
    expect(count).toBe(MAX_CHILDREN);
  });

  it("«Назад» возвращает на предыдущий шаг", async () => {
    const evacuation = await addSection("Эвакуация и хранение", {
      text: "Эвакуация или хранение?",
    });
    await addSection("Хранение", { text: "▪️ хранение категории А" }, evacuation.id);

    const root = (await send(STRANGER, "привет")).last;
    const choice = (await press(STRANGER, tap(root.attachments, "Эвакуация и хранение"))).last;
    expect(Object.keys(buttons(choice.attachments))).toEqual(["Хранение", BACK_TEXT]);
    const leaf = (await press(STRANGER, tap(choice.attachments, "Хранение"))).last;
    const back = (await press(STRANGER, tap(leaf.attachments, BACK_TEXT))).last;
    expect(back.text).toBe("Эвакуация или хранение?");
    const home = (await press(STRANGER, tap(back.attachments, BACK_TEXT))).last;
    expect(home.text).toBe(ROOT_TEXT);
    expect(Object.keys(buttons(home.attachments))).toEqual(["Эвакуация и хранение"]);
  });

  it.each(["menu:about", new SectionPayload(999).pack()])(
    "чужой или устаревший payload %s — главное меню",
    async (payload) => {
      const stale = await press(STRANGER, payload);
      expect(stale.notification).toBe(STALE_TEXT);
      expect(stale.last.text).toBe(ROOT_TEXT);
    },
  );

  it("MAX отказал в правке (4xx): нажатие подтверждено, экран пришёл новым", async () => {
    const api = new FakeApi();
    api.failEdit = new MaxError(400, { code: "edit.refused", message: "" });
    await press(STRANGER, new SectionPayload(999).pack(), api);
    expect(api.answers.at(-1)).toEqual({ notification: STALE_TEXT });
    expect(api.last).toMatchObject({ text: ROOT_TEXT, via: "chat" });
  });

  it("исходного сообщения нет — экран уходит пользователю в личку", async () => {
    const api = await press(STRANGER, new SectionPayload(999).pack(), new FakeApi(), true);
    expect(api.last).toMatchObject({ text: ROOT_TEXT, via: "user" });
  });

  it("5xx на правке: второе сообщение не шлём — правка могла пройти", async () => {
    const api = new FakeApi();
    api.failEdit = new MaxError(502, { code: "bad.gateway", message: "" });
    await press(STRANGER, new SectionPayload(999).pack(), api);
    expect(api.shown).toEqual([]);
    expect(api.answers).toEqual([]);
  });

  it("админ превращает раздел в кнопку-ссылку и обратно", async () => {
    await press(ADMIN, tap((await openAdmin()).attachments, "➕ Добавить подраздел"));
    const added = (await send(ADMIN, "О комитете")).last;

    expect((await press(ADMIN, tap(added.attachments, "🔗 Ссылка"))).last.text).toContain(
      "Пришлите ссылку",
    );
    expect((await send(ADMIN, "urt.volgograd.ru")).last.text.startsWith("⚠️")).toBe(true);
    const saved = (await send(ADMIN, "https://urt.volgograd.ru")).last;
    expect(saved.text).toContain("Ссылка сохранена");
    expect(saved.text).toContain("🔗 Кнопка открывает ссылку: https://urt.volgograd.ru/");

    expect(buttons((await send(STRANGER, "привет")).last.attachments)["О комитете"]).toBe(
      "https://urt.volgograd.ru/",
    );
    expect(AdminPayload.matches(tap((await openAdmin()).attachments, "🔗 О комитете"))).toBe(true);

    await press(ADMIN, tap(saved.attachments, "🔗 Ссылка"));
    expect((await send(ADMIN, CLEAR)).last.text).toContain("Ссылка убрана");
    expect(tap((await send(STRANGER, "привет")).last.attachments, "О комитете")).toMatch(/^s:/);
  });

  it("у главного меню нет действия «Ссылка»", async () => {
    expect(buttons((await openAdmin()).attachments)).not.toHaveProperty("🔗 Ссылка");
  });

  it("старая кнопка раздела, ставшего ссылкой, не открывает скрытый текст", async () => {
    const about = await addSection("О комитете", { text: "скрытый текст" });
    const oldPayload = tap((await send(STRANGER, "привет")).last.attachments, "О комитете");
    await withTransaction((db) =>
      new SectionRepository(db).save({ ...about, url: "https://urt.volgograd.ru" }),
    );
    const screen = (await press(STRANGER, oldPayload)).last;
    expect(screen.text).toBe(ROOT_TEXT);
    expect(buttons(screen.attachments)["О комитете"]).toBe("https://urt.volgograd.ru");
  });

  it("предпросмотр раздела-ссылки показывает саму кнопку", async () => {
    const link = await addSection("О комитете", { url: "https://urt.volgograd.ru" });
    const api = await press(ADMIN, new AdminPayload(AdminAction.Preview, link.id).pack());
    expect(api.last.text).toContain("сразу открывает ссылку");
    expect(buttons(api.last.attachments)).toEqual({ "О комитете": "https://urt.volgograd.ru" });
  });

  it("битый адрес вроде http://[ не роняет обработчик, ожидание остаётся", async () => {
    const link = await addSection("Сайт");
    await press(ADMIN, new AdminPayload(AdminAction.Link, link.id).pack());
    expect((await send(ADMIN, "http://[")).last.text.startsWith("⚠️")).toBe(true);
    expect(waiting.has(ADMIN)).toBe(true);
  });
});
