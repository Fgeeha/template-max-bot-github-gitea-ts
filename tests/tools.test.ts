/** Инструменты админки: администраторы, статистика, экспорт/импорт, журнал. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPORT_FORMAT, EXPORT_VERSION, parseTree } from "../src/handlers/inputs.js";
import { waiting } from "../src/handlers/pending.js";
import { AdminAction, AdminPayload } from "../src/keyboards/callbacks.js";
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

const HELPER = 3;
const tool = (action: AdminAction, target = 0) => new AdminPayload(action, target).pack();
const adminRoot = async (userId = ADMIN) => (await send(userId, "/admin")).last;

beforeEach(async () => {
  withEnv({ ADMIN_IDS: String(ADMIN) });
  resetPending();
  await resetDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("администраторы", () => {
  it("владелец добавляет и отзывает администратора", async () => {
    expect((await press(HELPER, tool(AdminAction.Home))).answers).toEqual([
      { notification: "Недоступно" },
    ]);

    await press(ADMIN, tool(AdminAction.StaffAdd));
    expect((await send(ADMIN, "не число")).last.text.startsWith("⚠️")).toBe(true);
    const added = (await send(ADMIN, String(HELPER))).last;
    expect(added.text).toContain("Администратор добавлен");
    expect(added.text).toContain(String(HELPER));

    // Помощник видит админку, но управлять администраторами не может.
    expect((await adminRoot(HELPER)).text).toContain("⚙️ Админка");
    expect((await press(HELPER, tool(AdminAction.StaffAdd))).notification).toMatch(/^Только/);
    expect(
      Object.keys(buttons((await press(HELPER, tool(AdminAction.Staff))).last.attachments)),
    ).toEqual(["◀️ Назад"]);

    const confirm = await press(ADMIN, tap(added.attachments, `🗑 ${HELPER}`));
    const revoked = await press(ADMIN, tap(confirm.last.attachments, "✅ Да, отозвать"));
    expect(revoked.notification).toBe("Доступ отозван");
    expect((await press(HELPER, tool(AdminAction.Home))).answers).toEqual([
      { notification: "Недоступно" },
    ]);
  });

  it("владельца из ADMIN_IDS в staff не добавляют", async () => {
    await press(ADMIN, tool(AdminAction.StaffAdd));
    expect((await send(ADMIN, String(ADMIN))).last.text).toContain("владелец из ADMIN_IDS");
  });

  it("отозванный во время ввода администратор попадает в обычное меню", async () => {
    await press(ADMIN, tool(AdminAction.StaffAdd));
    const added = (await send(ADMIN, String(HELPER))).last;
    await press(HELPER, tap((await adminRoot(HELPER)).attachments, "➕ Добавить подраздел"));
    expect(waiting.has(HELPER)).toBe(true);

    const confirm = await press(ADMIN, tap(added.attachments, `🗑 ${HELPER}`));
    await press(ADMIN, tap(confirm.last.attachments, "✅ Да, отозвать"));
    const reply = (await send(HELPER, "Новый раздел")).last;
    expect(reply.text).toBe("Выберите раздел 👇");
    expect(waiting.has(HELPER)).toBe(false);
  });
});

describe("статистика", () => {
  async function addPrices() {
    await press(ADMIN, tap((await adminRoot()).attachments, "➕ Добавить подраздел"));
    return (await send(ADMIN, "Цены")).last;
  }

  it("считает пользователей, но не администраторов", async () => {
    await addPrices();
    const menu = (await send(STRANGER, "привет")).last;
    await press(STRANGER, tap(menu.attachments, "Цены"));
    await press(STRANGER, tap(menu.attachments, "Цены"));
    await press(ADMIN, tap(menu.attachments, "Цены"));

    const text = (await press(ADMIN, tool(AdminAction.Stats, 7))).last.text;
    expect(text).toContain("Открытий разделов: 2");
    expect(text).toContain("Пользователей: 1");
    expect(text).toContain("1. Цены — 2 / 1");
  });

  it("STATS_ENABLED=false ничего не пишет", async () => {
    withEnv({ ADMIN_IDS: String(ADMIN), STATS_ENABLED: "false" });
    await addPrices();
    const menu = (await send(STRANGER, "привет")).last;
    await press(STRANGER, tap(menu.attachments, "Цены"));
    const text = (await press(ADMIN, tool(AdminAction.Stats, 30))).last.text;
    expect(text).toContain("Открытий разделов: 0");
    expect(text).toContain("Сбор выключен");
  });

  it("открытия удалённого раздела остаются в итогах", async () => {
    const added = await addPrices();
    await press(STRANGER, tap((await send(STRANGER, "привет")).last.attachments, "Цены"));
    const confirm = await press(ADMIN, tap(added.attachments, "🗑 Удалить"));
    await press(ADMIN, tap(confirm.last.attachments, "✅ Да, удалить"));
    expect((await press(ADMIN, tool(AdminAction.Stats, 30))).last.text).toContain(
      "удалённые разделы — 1 / 1",
    );
  });
});

describe("экспорт и импорт", () => {
  it("выгруженный файл загружается обратно и заменяет разделы", async () => {
    await press(ADMIN, tap((await adminRoot()).attachments, "➕ Добавить подраздел"));
    const added = (await send(ADMIN, "Услуги")).last;
    await press(ADMIN, tap(added.attachments, "📝 Текст"));
    await send(ADMIN, "я".repeat(500));

    const exported = await press(ADMIN, tool(AdminAction.Export));
    expect(exported.notification).toBe("Файл — сообщением ниже");
    expect(exported.last.attachments).toEqual([{ type: "file", payload: { token: "file-token" } }]);
    const doc = JSON.parse(exported.uploads[0] as string);
    expect(doc.format).toBe(EXPORT_FORMAT);
    expect(doc.root.children[0]).toMatchObject({ title: "Услуги", text: "я".repeat(500) });

    // Меняем название в файле и грузим его вместо текущих разделов.
    doc.root.children[0].title = "Услуги и цены";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(doc)));
    const asked = await press(ADMIN, tool(AdminAction.Import));
    expect(asked.uploads).toHaveLength(1); // резервная копия до замены
    expect(asked.last.text).toContain("Пришлите JSON-файл");
    const file = { url: "https://files.example/sections.json", filename: "sections.json" };
    const loaded = (await send(ADMIN, "", { file })).last;
    expect(loaded.text).toContain("Разделы загружены");
    expect(waiting.has(ADMIN)).toBe(false);

    const user = (await send(STRANGER, "привет")).last;
    const screen = (await press(STRANGER, tap(user.attachments, "Услуги и цены"))).last;
    expect(screen.text).toBe("я".repeat(500));
  });

  it("текст вместо файла — ошибка, ожидание остаётся", async () => {
    await press(ADMIN, tool(AdminAction.Import));
    expect((await send(ADMIN, "вот текст")).last.text.startsWith("⚠️")).toBe(true);
    expect(waiting.has(ADMIN)).toBe(true);
  });

  it("файл не по https не скачивается", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await press(ADMIN, tool(AdminAction.Import));
    const file = { url: "http://10.0.0.1/sections.json", filename: "x.json" };
    expect((await send(ADMIN, "", { file })).last.text).toContain("Не удалось скачать");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("файл, который MAX ещё обрабатывает, отправляется повторно", async () => {
    const api = new FakeApi();
    api.fileNotReady = 1; // одна пауза в 1 с — реальные таймеры, PGlite с фейковыми не работает
    await press(ADMIN, tool(AdminAction.Export), api);
    expect(api.fileNotReady).toBe(0);
    expect(api.last.attachments).toEqual([{ type: "file", payload: { token: "file-token" } }]);
  });

  it("без исходного сообщения экспорт уходит администратору в личку", async () => {
    const api = await press(ADMIN, tool(AdminAction.Export), new FakeApi(), true);
    expect(api.shown[0]?.via).toBe("user");
    expect(JSON.parse(api.uploads[0] as string).format).toBe(EXPORT_FORMAT);
  });
});

describe("журнал", () => {
  it("показывает правки, новые сверху", async () => {
    await press(ADMIN, tap((await adminRoot()).attachments, "➕ Добавить подраздел"));
    const added = (await send(ADMIN, "Акции")).last;
    await press(ADMIN, tap(added.attachments, "📝 Текст"));
    await send(ADMIN, "Скидка 10%");
    const text = (await press(ADMIN, tool(AdminAction.Log))).last.text;
    expect(text).toContain("добавил раздел «Акции»");
    expect(text).toContain("изменил текст «Акции»");
    expect(text.indexOf("изменил текст")).toBeLessThan(text.indexOf("добавил раздел"));
  });
});

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const fileOf = (root: unknown) => encode({ format: EXPORT_FORMAT, version: EXPORT_VERSION, root });
const node = (title = "Раздел", extra: Record<string, unknown> = {}) => ({
  title,
  text: "",
  url: null,
  image_token: null,
  children: [],
  ...extra,
});

describe("parseTree", () => {
  it.each([
    [new TextEncoder().encode("not json"), "не JSON"],
    [encode({ root: {} }), "format/version"],
    [fileOf(node("Корень", { children: [node("x".repeat(65))] })), "длиннее 64"],
    [fileOf(node("Корень", { children: [node("a", { url: "javascript:alert(1)" })] })), "https://"],
    [
      fileOf(node("Корень", { children: Array.from({ length: 25 }, (_, i) => node(String(i))) })),
      "не больше 24",
    ],
    [fileOf(node("Корень", { text: 123 })), "строкой"],
    [fileOf(node("Корень", { children: [node("a\u0000b")] })), "NUL"],
  ])("отклоняет битый файл (%#)", (data, error) => {
    const result = parseTree(data);
    expect(result.value).toBeUndefined();
    expect(result.error).toContain(error);
  });

  it("нормализует: ссылку у корня убирает, домен переводит в punycode", () => {
    const result = parseTree(
      fileOf(
        node("Корень", {
          url: "https://root.ru",
          children: [node(" Сайт ", { url: "https://пример.рф" })],
        }),
      ),
    );
    expect(result.error).toBeUndefined();
    expect(result.value?.url).toBeNull();
    expect(result.value?.children[0]?.title).toBe("Сайт");
    expect(result.value?.children[0]?.url).toBe("https://xn--e1afmkfd.xn--p1ai/");
  });
});
