/** Регистрация middleware/хендлеров и маршрутизация апдейтов. */
import type { Bot } from "./bot.js";
import type { Filter } from "./filters.js";
import {
  type BotStarted,
  MessageCallback,
  MessageCreated,
  parseUpdate,
  type RawUpdate,
  type UpdateEvent,
} from "./types.js";

export type Middleware = (next: () => Promise<void>, event: UpdateEvent) => Promise<void>;

interface Registration<T> {
  filter?: Filter<T>;
  handler: (event: T) => Promise<void>;
}

const POLL_ERROR_BACKOFF_MS = 1000;

export class Dispatcher {
  private readonly messageHandlers: Registration<MessageCreated>[] = [];
  private readonly callbackHandlers: Registration<MessageCallback>[] = [];
  private readonly botStartedHandlers: Registration<BotStarted>[] = [];
  private readonly outerMiddlewares: Middleware[] = [];
  private polling = false;

  /** Порядок регистрации значим: первый подошедший фильтр обрабатывает апдейт. */
  onMessageCreated(
    handler: (event: MessageCreated) => Promise<void>,
    filter?: Filter<MessageCreated>,
  ): void {
    this.messageHandlers.push({ filter, handler });
  }

  onMessageCallback(handler: (event: MessageCallback) => Promise<void>): void {
    this.callbackHandlers.push({ handler });
  }

  onBotStarted(handler: (event: BotStarted) => Promise<void>): void {
    this.botStartedHandlers.push({ handler });
  }

  /** Оборачивает обработку целиком: гейт доступа, лимиты и т.п. Порядок регистрации = порядок вложенности. */
  registerOuterMiddleware(middleware: Middleware): void {
    this.outerMiddlewares.push(middleware);
  }

  async dispatch(bot: Bot, raw: RawUpdate): Promise<void> {
    const event = parseUpdate(bot, raw);
    if (event === undefined) return;

    const core = (): Promise<void> => this.route(event);
    const chain = this.outerMiddlewares.reduceRight<() => Promise<void>>(
      (next, middleware) => () => middleware(next, event),
      core,
    );
    await chain();
  }

  private async route(event: UpdateEvent): Promise<void> {
    if (event instanceof MessageCreated) {
      for (const { filter, handler } of this.messageHandlers) {
        if (!filter || filter(event)) {
          await handler(event);
          return;
        }
      }
      return;
    }
    if (event instanceof MessageCallback) {
      const first = this.callbackHandlers[0];
      if (first) await first.handler(event);
      return;
    }
    const first = this.botStartedHandlers[0];
    if (first) await first.handler(event);
  }

  /** Long polling: снимает апдейты через /updates, пока stopPolling() не остановит цикл. */
  async startPolling(bot: Bot): Promise<void> {
    this.polling = true;
    let marker: number | undefined;
    while (this.polling) {
      let batch: { updates: RawUpdate[]; marker?: number };
      try {
        batch = await bot.getUpdates({ marker, timeout: 30 });
      } catch (error) {
        console.error("polling: не удалось получить апдейты, повтор через 1с:", error);
        await sleep(POLL_ERROR_BACKOFF_MS);
        continue;
      }
      for (const raw of batch.updates) {
        try {
          await this.dispatch(bot, raw);
        } catch (error) {
          console.error("polling: необработанное исключение при обработке апдейта:", error);
        }
      }
      marker = batch.marker ?? marker;
    }
  }

  stopPolling(): void {
    this.polling = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
