/**
 * Тесты приёма апдейтов вебхука вне HTTP-запроса (src/webhook.ts).
 *
 * Проверяем главное свойство ради которого всё делалось: ответ MAX не ждёт
 * обработку апдейта, а очередь обработки ограничена — при переполнении
 * маршрут отвечает 503, а не копит соединения.
 */
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { RawUpdate } from "../src/max/types.js";
import { BackgroundDispatcher, createWebhookListener } from "../src/webhook.js";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Заглушка обработчика апдейта: считает вызовы и умеет «зависать» до release(). */
class FakeHandler {
  calls: RawUpdate[] = [];
  started = deferred<void>();
  release = deferred<void>();
  fail = false;

  run = async (raw: RawUpdate): Promise<void> => {
    this.calls.push(raw);
    this.started.resolve();
    await this.release.promise;
    if (this.fail) throw new Error("обработка упала");
  };
}

interface Context {
  server: Server;
  fake: FakeHandler;
  dispatcher: BackgroundDispatcher;
  baseUrl: string;
}

async function buildContext(maxPending = 2, secret?: string): Promise<Context> {
  const fake = new FakeHandler();
  const dispatcher = new BackgroundDispatcher(fake.run, maxPending);
  const server = createServer(
    createWebhookListener(dispatcher, { path: "/webhook", secret, buildTag: "" }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, fake, dispatcher, baseUrl: `http://127.0.0.1:${port}` };
}

function post(
  baseUrl: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/webhook`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("webhook queue", () => {
  let activeServer: Server | undefined;

  afterEach(async () => {
    if (activeServer) {
      await new Promise<void>((resolve) => activeServer?.close(() => resolve()));
    }
    activeServer = undefined;
  });

  it("ответ приходит раньше, чем обработка завершится", async () => {
    const ctx = await buildContext();
    activeServer = ctx.server;

    const response = await post(ctx.baseUrl, JSON.stringify({ update_type: "message_created" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    await ctx.fake.started.promise;
    expect(ctx.dispatcher.pending).toBe(1);
    ctx.fake.release.resolve();
    await ctx.dispatcher.drain(1000);

    expect(ctx.dispatcher.pending).toBe(0);
    expect(ctx.fake.calls).toEqual([{ update_type: "message_created" }]);
  });

  it("сверх max_pending апдейты получают 503, а не копятся", async () => {
    const ctx = await buildContext(2);
    activeServer = ctx.server;

    for (let i = 0; i < 2; i += 1) {
      const response = await post(ctx.baseUrl, JSON.stringify({ update_type: "x" }));
      expect(response.status).toBe(200);
    }
    const overflow = await post(ctx.baseUrl, JSON.stringify({ update_type: "x" }));
    expect(overflow.status).toBe(503);
    expect(ctx.dispatcher.pending).toBe(2);

    ctx.fake.release.resolve();
    await ctx.dispatcher.drain(1000);
    // Отклонённый апдейт до обработки не дошёл — MAX повторит доставку.
    expect(ctx.fake.calls.length).toBe(2);
  });

  it("слот освобождается по завершении обработки", async () => {
    const ctx = await buildContext(1);
    activeServer = ctx.server;

    expect((await post(ctx.baseUrl, JSON.stringify({ update_type: "x" }))).status).toBe(200);
    expect((await post(ctx.baseUrl, JSON.stringify({ update_type: "x" }))).status).toBe(503);

    ctx.fake.release.resolve();
    await ctx.dispatcher.drain(1000);
    expect(ctx.dispatcher.pending).toBe(0);

    expect((await post(ctx.baseUrl, JSON.stringify({ update_type: "x" }))).status).toBe(200);
    await ctx.dispatcher.drain(1000);
    expect(ctx.fake.calls.length).toBe(2);
  });

  it("без правильного заголовка апдейт не принимается", async () => {
    const ctx = await buildContext(2, "s3cret");
    activeServer = ctx.server;

    expect((await post(ctx.baseUrl, "{}")).status).toBe(403);
    expect((await post(ctx.baseUrl, "{}", { "x-max-bot-api-secret": "nope" })).status).toBe(403);
    const good = await post(ctx.baseUrl, "{}", { "x-max-bot-api-secret": "s3cret" });
    expect(good.status).toBe(200);

    ctx.fake.release.resolve();
    await ctx.dispatcher.drain(1000);
    expect(ctx.fake.calls.length).toBe(1);
  });

  it("битое тело не попадает в обработку", async () => {
    const ctx = await buildContext();
    activeServer = ctx.server;

    const response = await post(ctx.baseUrl, "{not json");
    expect(response.status).toBe(400);
    expect(ctx.fake.calls).toEqual([]);
    expect(ctx.dispatcher.pending).toBe(0);
  });

  it("исключение в обработке освобождает слот и не роняет приём", async () => {
    const ctx = await buildContext(1);
    activeServer = ctx.server;
    ctx.fake.fail = true;

    expect((await post(ctx.baseUrl, JSON.stringify({ update_type: "x" }))).status).toBe(200);
    ctx.fake.release.resolve();
    await ctx.dispatcher.drain(1000);
    expect(ctx.dispatcher.pending).toBe(0);

    expect((await post(ctx.baseUrl, JSON.stringify({ update_type: "x" }))).status).toBe(200);
    await ctx.dispatcher.drain(1000);
  });

  it("drain перестаёт ждать по таймауту, не отменяя задачу", async () => {
    const ctx = await buildContext();
    activeServer = ctx.server;

    expect((await post(ctx.baseUrl, JSON.stringify({ update_type: "x" }))).status).toBe(200);
    await ctx.fake.started.promise;
    await ctx.dispatcher.drain(50); // release так и не выставлен

    // В отличие от asyncio.Task, Promise в JS нельзя отменить — задача всё
    // ещё числится в очереди, drain лишь перестал её ждать.
    expect(ctx.dispatcher.pending).toBe(1);
    ctx.fake.release.resolve();
    await ctx.dispatcher.drain(1000);
    expect(ctx.dispatcher.pending).toBe(0);
  });
});
