/**
 * Троттлинг, ретраи на 429 и CA-bundle для клиента MAX API.
 *
 * В Python-версии шаблона это monkey-patch над внешней библиотекой maxapi.
 * Здесь клиент собственный (src/max/bot.ts), поэтому лимиты и ретраи
 * встраиваются обычной композицией функций — тот же результат без патчинга.
 */
import { readFileSync } from "node:fs";
import { MaxApiError } from "./max/errors.js";

const MAX_RETRY = 5;

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
 * Троттлит запрос лимитером и ретраит на 429 с экспоненциальной задержкой.
 *
 * Особенность платформы: при 429 MAX может отдавать тело не в JSON — это
 * долетает до вызывающего кода как MaxApiError(code=429) из src/max/bot.ts.
 */
export async function withRateLimitAndRetry<T>(
  limiter: RateLimiter,
  fn: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRY; attempt += 1) {
    await limiter.acquire();
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof MaxApiError) || error.code !== 429 || attempt === MAX_RETRY - 1) {
        throw error;
      }
      const waitMs = Math.min(2 ** attempt * 1000, 30_000);
      console.warn(
        `MAX API 429 (rate limit), попытка ${attempt + 1}/${MAX_RETRY}, жду ${Math.round(waitMs / 1000)} с`,
      );
      await sleep(waitMs);
    }
  }
  throw new MaxApiError(429, { error: "unreachable" });
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
