/** Картинки разделов: установка в админке, отказ MAX и откат на экран без фото. */
import { MaxError } from "@maxhub/max-bot-api";
import type { AttachmentRequest } from "@maxhub/max-bot-api/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTransaction } from "../src/db/pool.js";
import { SectionRepository } from "../src/db/repositories/sections.js";
import { CLEAR } from "../src/handlers/inputs.js";
import { loadRoot, sendScreen } from "../src/handlers/menu.js";
import { waiting } from "../src/handlers/pending.js";
import { buildScreen } from "../src/handlers/screens.js";
import { SectionPayload } from "../src/keyboards/callbacks.js";
import { BACK_TEXT } from "../src/keyboards/menus.js";
import { ADMIN, FakeApi, press, resetPending, STRANGER, send, tap } from "./helpers/bot.js";
import { query, resetDb } from "./helpers/db.js";
import { withEnv } from "./helpers/env.js";

vi.mock("../src/db/pool.js", () => import("./helpers/db.js").then((m) => m.poolMock));

const images = (attachments: AttachmentRequest[]) =>
  attachments.flatMap((a) => (a.type === "image" ? [a.payload.token] : []));
const adminRoot = async () => (await send(ADMIN, "/admin")).last;

async function setRootImage(token: string): Promise<void> {
  await withTransaction(async (db) => {
    const repo = new SectionRepository(db);
    await repo.save({ ...(await repo.root()), imageToken: token });
  });
}

beforeEach(async () => {
  withEnv({ ADMIN_IDS: String(ADMIN) });
  resetPending();
  await resetDb();
});

describe("картинки разделов", () => {
  it("админ ставит картинку главному меню; в подразделе её нет; «-» убирает", async () => {
    const ask = await press(ADMIN, tap((await adminRoot()).attachments, "🖼 Картинка"));
    expect(ask.last.text).toContain("Пришлите одну картинку");
    expect((await send(ADMIN, "картинка")).last.text.startsWith("⚠️")).toBe(true);
    const saved = (await send(ADMIN, "", { image: "root-photo" })).last;
    expect(saved.text).toContain("Картинка сохранена");
    expect(saved.text).toContain("🖼 Картинка: есть");

    await press(ADMIN, tap(saved.attachments, "➕ Добавить подраздел"));
    await send(ADMIN, "Техосмотр");

    const root = (await send(STRANGER, "привет")).last;
    expect(images(root.attachments)).toEqual(["root-photo"]);
    const screen = (await press(STRANGER, tap(root.attachments, "Техосмотр"))).last;
    expect(images(screen.attachments)).toEqual([]);
    const back = (await press(STRANGER, tap(screen.attachments, BACK_TEXT))).last;
    expect(images(back.attachments)).toEqual(["root-photo"]);

    await press(ADMIN, tap((await adminRoot()).attachments, "🖼 Картинка"));
    expect((await send(ADMIN, CLEAR)).last.text).toContain("Картинка убрана");
    expect(images((await send(STRANGER, "привет")).last.attachments)).toEqual([]);
  });

  it("фото без подписи — ввод только для «🖼 Картинка», не для текста", async () => {
    const root = await adminRoot();
    await press(ADMIN, tap(root.attachments, "📝 Текст"));
    expect((await send(ADMIN, "", { image: "tok" })).last.text).toBe("Выберите раздел 👇");
    await press(ADMIN, tap(root.attachments, "🖼 Картинка"));
    expect((await send(ADMIN, "", { image: "tok" })).last.text).toContain("Картинка сохранена");
  });

  it("MAX не принял токен — экран уходит без картинки; 5xx не глушится", async () => {
    await setRootImage("expired");
    const calls: AttachmentRequest[][] = [];
    const screen = await loadRoot();
    await sendScreen(
      async (_text, attachments) => {
        calls.push(attachments);
        if (images(attachments).length)
          throw new MaxError(400, { code: "attachment.invalid", message: "" });
      },
      screen.text,
      screen.attachments,
    );
    expect(calls).toHaveLength(2);
    expect(images(calls[1] ?? [])).toEqual([]);

    const down = new MaxError(503, { code: "down", message: "" });
    await expect(
      sendScreen(() => Promise.reject(down), screen.text, screen.attachments),
    ).rejects.toBe(down);
  });

  it("правка экрана с отклонённой картинкой повторяется без неё, нового сообщения нет", async () => {
    await setRootImage("expired");
    const api = new FakeApi();
    api.rejectImages = true;
    await press(STRANGER, new SectionPayload(999).pack(), api);
    expect(api.shown).toHaveLength(1);
    expect(api.last).toMatchObject({ via: "edit", text: "Выберите раздел 👇" });
    expect(images(api.last.attachments)).toEqual([]);
  });

  it("MAX отказал в правке не из-за картинки — новое сообщение с картинкой", async () => {
    await setRootImage("good-photo");
    const api = new FakeApi();
    api.failEdit = new MaxError(400, { code: "message.too.old", message: "" });
    await press(STRANGER, new SectionPayload(999).pack(), api);
    expect(api.last.via).toBe("chat");
    expect(images(api.last.attachments)).toEqual(["good-photo"]);
  });

  it("картинку, которую MAX не может показать, бот не сохраняет", async () => {
    await press(ADMIN, tap((await adminRoot()).attachments, "🖼 Картинка"));
    const api = new FakeApi();
    api.rejectImages = true;
    await send(ADMIN, "", { image: "bad", api });
    expect(api.last.text.startsWith("⚠️ MAX не принял")).toBe(true);
    expect(waiting.has(ADMIN)).toBe(true);
    const { rows } = await query("SELECT image_token FROM sections WHERE parent_id IS NULL");
    expect(rows[0]?.image_token).toBeNull();
  });

  it("файл вместо фото — бот объясняет, а не показывает меню", async () => {
    await press(ADMIN, tap((await adminRoot()).attachments, "🖼 Картинка"));
    const file = { url: "https://files.example/a.png", filename: "a.png" };
    expect((await send(ADMIN, "", { file })).last.text).toContain("как фото, не файлом");
  });

  it("подпись к фото сохраняется текстом с предупреждением о картинке", async () => {
    await press(ADMIN, tap((await adminRoot()).attachments, "📝 Текст"));
    const saved = (await send(ADMIN, "Новое приветствие", { image: "tok" })).last;
    expect(saved.text).toContain("Картинку из сообщения я не сохранил");
  });

  it("у раздела-ссылки статус картинки честный", async () => {
    const text = await withTransaction(async (db) => {
      const repo = new SectionRepository(db);
      const link = await repo.add((await repo.root()).id, "О комитете");
      const updated = { ...link, url: "https://urt.volgograd.ru", imageToken: "tok" };
      await repo.save(updated);
      return (await buildScreen(repo, updated)).text;
    });
    expect(text).toContain("сохранена, появится, если убрать ссылку");
  });
});
