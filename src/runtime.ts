/**
 * Троттлинг, ретраи на 429 и CA-bundle для клиента MAX API.
 *
 * @maxhub/max-bot-api (официальный клиент) вызывает глобальный fetch напрямую
 * и не даёт хуков для лимитов/ретраев/кастомного CA. Как и Python-версия
 * шаблона (которая патчит внешнюю библиотеку maxapi), здесь патчится
 * globalThis.fetch — единственная точка, через которую проходят все запросы
 * официального клиента.
 */
import { readFileSync } from "node:fs";
import { Agent, setGlobalDispatcher } from "undici";

const MAX_RETRY = 5;
// Патчим только для эндпоинта отправки/удаления сообщений — у него отдельный,
// более строгий антиспам-лимит платформы (см. MAX_API_MESSAGE_RPS).
const MESSAGE_ENDPOINT_PATH = "/messages";

class Semaphore {
  private available: number;
  private readonly queue: (() => void)[] = [];

  constructor(count: number) {
    this.available = count;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.available += 1;
    }
  }
}

/**
 * Sliding-window ограничитель: слот занимается при каждом запросе и
 * освобождается ровно через periodMs — не более maxCalls запросов в любом
 * окне такой длины. В отличие от «сбрасываемого счётчика» не допускает
 * всплеска 2×maxCalls на стыке двух окон.
 */
export class RateLimiter {
  private readonly semaphore: Semaphore;
  private readonly periodMs: number;

  constructor(maxCalls: number, periodMs = 1000) {
    this.semaphore = new Semaphore(maxCalls);
    this.periodMs = periodMs;
  }

  async acquire(): Promise<void> {
    await this.semaphore.acquire();
    setTimeout(() => this.semaphore.release(), this.periodMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Загружает дополнительный CA-bundle (PEM). undefined, если путь не задан —
 * тогда используются системные сертификаты без изменений.
 */
export function buildTlsCa(caBundlePath: string | undefined): Buffer | undefined {
  if (!caBundlePath) return undefined;
  try {
    const buffer = readFileSync(caBundlePath);
    console.info(`SSL CA-bundle загружен: ${caBundlePath}`);
    return buffer;
  } catch (error) {
    console.error(`Не удалось загрузить CA-bundle ${caBundlePath}:`, error);
    throw error;
  }
}

/**
 * Применяет CA-bundle к глобальному fetch (undici) — единственный способ
 * повлиять на TLS официального клиента, который сам не принимает агента.
 */
export function applyTlsCa(caBundlePath: string | undefined): void {
  const ca = buildTlsCa(caBundlePath);
  if (!ca) return;
  setGlobalDispatcher(new Agent({ connect: { ca } }));
}

/**
 * Патчит globalThis.fetch: троттлинг всех запросов лимитером apiLimiter,
 * дополнительный лимит messageLimiter — только для POST/DELETE /messages,
 * ретрай на HTTP 429 с экспоненциальной задержкой.
 *
 * Патчится один раз за процесс — вызывайте до первого обращения к API.
 */
export function patchFetchForRateLimiting(
  apiLimiter: RateLimiter,
  messageLimiter: RateLimiter,
): void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const isMessageCall =
      url.pathname === MESSAGE_ENDPOINT_PATH && (method === "POST" || method === "DELETE");

    for (let attempt = 0; attempt < MAX_RETRY; attempt += 1) {
      await apiLimiter.acquire();
      if (isMessageCall) await messageLimiter.acquire();

      const response = await originalFetch(input, init);
      if (response.status !== 429 || attempt === MAX_RETRY - 1) {
        return response;
      }

      const waitMs = Math.min(2 ** attempt * 1000, 30_000);
      console.warn(
        `MAX API 429 (rate limit), попытка ${attempt + 1}/${MAX_RETRY}, жду ${Math.round(waitMs / 1000)} с`,
      );
      await sleep(waitMs);
    }
    // Недостижимо: цикл всегда возвращается на последней попытке.
    throw new Error("unreachable");
  };

  console.info("Троттлинг и ретраи на 429 подключены к globalThis.fetch");
}
