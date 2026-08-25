/**
 * Приём апдейтов MAX без удержания HTTP-соединения на время обработки.
 *
 * Маршрут отвечает MAX сразу, а обработка уходит в фоновую задачу: очередь
 * копится в памяти (видно через /healthz, можно ограничить), а не в открытых
 * сокетах. При переполнении апдейт не принимается — MAX повторит доставку
 * позже, это честнее тихого накопления.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { Update } from "@maxhub/max-bot-api/types";

const SECRET_HEADER = "x-max-bot-api-secret";

export class BackgroundDispatcher {
  private readonly dispatchFn: (raw: Update) => Promise<void>;
  private readonly maxPending: number;
  private readonly tasks = new Set<Promise<void>>();

  constructor(dispatchFn: (raw: Update) => Promise<void>, maxPending: number) {
    if (maxPending <= 0) throw new Error("maxPending должен быть больше 0");
    this.dispatchFn = dispatchFn;
    this.maxPending = maxPending;
  }

  /** Сколько апдейтов сейчас в обработке. */
  get pending(): number {
    return this.tasks.size;
  }

  /** Ставит апдейт в обработку. false — очередь переполнена. */
  submit(eventJson: Update): boolean {
    if (this.tasks.size >= this.maxPending) {
      console.error(
        `Очередь обработки апдейтов переполнена (${this.maxPending}), апдейт отклонён: ${eventJson.update_type}`,
      );
      return false;
    }
    const task: Promise<void> = this.dispatchFn(eventJson)
      .catch((error: unknown) => {
        console.error("Необработанное исключение при обработке апдейта:", error);
      })
      .finally(() => {
        this.tasks.delete(task);
      });
    this.tasks.add(task);
    return true;
  }

  /**
   * Ждёт завершения принятых апдейтов при остановке бота.
   *
   * В отличие от asyncio.Task, Promise в JS нельзя отменить — по истечении
   * timeoutMs метод просто перестаёт ждать, задачи в фоне не прерываются.
   */
  async drain(timeoutMs: number): Promise<void> {
    if (this.tasks.size === 0) return;
    console.info(`Жду завершения обработки ${this.tasks.size} апдейтов...`);
    const tasks = [...this.tasks];
    const timedOut = Symbol("timeout");
    const result = await Promise.race([
      Promise.all(tasks).then(() => undefined),
      new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), timeoutMs)),
    ]);
    if (result === timedOut) {
      console.warn(`Не дождался завершения апдейтов, осталось: ${this.tasks.size}`);
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export interface WebhookRouteOptions {
  path: string;
  secret: string | undefined;
  buildTag: string;
}

/**
 * Собирает обработчик HTTP-запросов вебхука + /healthz.
 *
 * Проверка секрета — заголовок X-Max-Bot-Api-Secret, сравнение через
 * timingSafeEqual. Маршрут свой (не сторонняя библиотека): только так можно
 * ответить 503 при переполнении очереди.
 */
export function createWebhookListener(
  dispatcher: BackgroundDispatcher,
  options: WebhookRouteOptions,
): RequestListener {
  return (req, res) => {
    void handle(req, res, dispatcher, options);
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  dispatcher: BackgroundDispatcher,
  options: WebhookRouteOptions,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, {
      status: "ok",
      build: options.buildTag,
      pending_updates: dispatcher.pending,
    });
    return;
  }

  if (req.method !== "POST" || url.pathname !== options.path) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  if (options.secret !== undefined) {
    const provided = req.headers[SECRET_HEADER];
    if (typeof provided !== "string" || !secretMatches(provided, options.secret)) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
  }

  let eventJson: Update;
  try {
    const raw = await readBody(req);
    eventJson = JSON.parse(raw) as Update;
  } catch {
    sendJson(res, 400, { error: "bad_request" });
    return;
  }

  if (!dispatcher.submit(eventJson)) {
    // 503 — сигнал MAX повторить доставку позже.
    sendJson(res, 503, { error: "overloaded" });
    return;
  }
  sendJson(res, 200, { ok: true });
}
