/**
 * Тонкий клиент MAX Bot API поверх undici (используется тем же HTTP-стеком,
 * что и глобальный fetch в Node). Пути эндпоинтов — лучшее приближение к
 * официальному API (https://dev.max.ru/); при расхождении с текущей
 * документацией правьте только этот файл, остального кода это не касается.
 */

import type { Dispatcher } from "undici";
import { Agent, request as undiciRequest } from "undici";
import { type RateLimiter, withRateLimitAndRetry } from "../runtime.js";
import { MaxApiError } from "./errors.js";
import type { Attachment, RawUpdate } from "./types.js";

export interface BotOptions {
  token: string;
  baseUrl?: string;
  /** Дополнительный CA-bundle (PEM), см. runtime.ts::buildTlsCa. */
  ca?: Buffer;
  /** Общий лимит исходящих запросов (MAX_API_RPS) — троттлит и ретраит 429. */
  apiRateLimiter?: RateLimiter;
  /** Отдельный, более строгий лимит на send/delete message (MAX_API_MESSAGE_RPS). */
  messageRateLimiter?: RateLimiter;
}

interface CallOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export class Bot {
  private baseUrl: string;
  private readonly token: string;
  private readonly agent: Agent;
  private readonly apiRateLimiter: RateLimiter | undefined;
  private readonly messageRateLimiter: RateLimiter | undefined;

  constructor(options: BotOptions) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? "https://platform-api2.max.ru";
    this.agent = new Agent(options.ca ? { connect: { ca: options.ca } } : {});
    this.apiRateLimiter = options.apiRateLimiter;
    this.messageRateLimiter = options.messageRateLimiter;
  }

  setApiUrl(url: string): void {
    this.baseUrl = url;
  }

  private async call<T>(method: string, path: string, options: CallOptions = {}): Promise<T> {
    const exec = async (): Promise<T> => {
      const url = new URL(this.baseUrl + path);
      url.searchParams.set("access_token", this.token);
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }

      const response = await undiciRequest(url, {
        method: method as Dispatcher.HttpMethod,
        dispatcher: this.agent,
        headers: options.body ? { "content-type": "application/json" } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

      if (response.statusCode >= 400) {
        const raw = await readErrorBody(response);
        throw new MaxApiError(response.statusCode, raw);
      }
      if (response.statusCode === 204) {
        await response.body.dump();
        return undefined as T;
      }
      return (await response.body.json()) as T;
    };

    return this.apiRateLimiter ? withRateLimitAndRetry(this.apiRateLimiter, exec) : exec();
  }

  async sendMessage(params: {
    chatId: number;
    text: string;
    attachments?: Attachment[];
  }): Promise<void> {
    if (this.messageRateLimiter) await this.messageRateLimiter.acquire();
    await this.call("POST", "/messages", {
      query: { chat_id: params.chatId },
      body: { text: params.text, attachments: params.attachments },
    });
  }

  async sendMessageToUser(params: {
    userId: number;
    text: string;
    attachments?: Attachment[];
  }): Promise<void> {
    if (this.messageRateLimiter) await this.messageRateLimiter.acquire();
    await this.call("POST", "/messages", {
      query: { user_id: params.userId },
      body: { text: params.text, attachments: params.attachments },
    });
  }

  async deleteMessage(messageId: string): Promise<void> {
    if (this.messageRateLimiter) await this.messageRateLimiter.acquire();
    await this.call("DELETE", "/messages", { query: { message_id: messageId } });
  }

  async answerCallback(
    callbackId: string,
    options: { notification?: string; text?: string },
  ): Promise<void> {
    await this.call("POST", "/answers", {
      query: { callback_id: callbackId },
      body: options.text
        ? { message: { text: options.text } }
        : { notification: options.notification },
    });
  }

  async subscribeWebhook(url: string, updateTypes: string[], secret: string): Promise<void> {
    await this.call("POST", "/subscriptions", { body: { url, update_types: updateTypes, secret } });
  }

  async deleteWebhook(): Promise<void> {
    await this.call("DELETE", "/subscriptions");
  }

  async getUpdates(params: {
    marker?: number;
    timeout?: number;
  }): Promise<{ updates: RawUpdate[]; marker?: number }> {
    return this.call("GET", "/updates", {
      query: { marker: params.marker, timeout: params.timeout ?? 30 },
    });
  }

  async close(): Promise<void> {
    await this.agent.close();
  }
}

async function readErrorBody(response: {
  headers: Record<string, unknown>;
  body: { json(): Promise<unknown>; text(): Promise<string> };
}): Promise<unknown> {
  const contentType = response.headers["content-type"];
  try {
    return typeof contentType === "string" && contentType.includes("json")
      ? await response.body.json()
      : await response.body.text();
  } catch {
    return null;
  }
}
