/** Проверки ограничителя частоты и загрузки CA-bundle. */
import { describe, expect, it } from "vitest";
import { RateLimiter, buildTlsCa } from "../src/runtime.js";

describe("RateLimiter", () => {
  it("пропускает первые maxCalls запросов без задержки", async () => {
    const limiter = new RateLimiter(5, 1000);
    const start = Date.now();
    await Promise.all(Array.from({ length: 5 }, () => limiter.acquire()));
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("запрос сверх лимита ждёт освобождения слота", async () => {
    const limiter = new RateLimiter(2, 200);
    const start = Date.now();
    for (let i = 0; i < 4; i += 1) {
      await limiter.acquire();
    }
    // Четыре запроса при лимите 2/200мс — минимум одно окно ожидания.
    expect(Date.now() - start).toBeGreaterThanOrEqual(190);
  });
});

describe("buildTlsCa", () => {
  it("без MAX_CA_BUNDLE ничего не грузит", () => {
    expect(buildTlsCa(undefined)).toBeUndefined();
    expect(buildTlsCa("")).toBeUndefined();
  });

  it("опечатка в пути не должна тихо оставлять системные CA", () => {
    expect(() => buildTlsCa("/nonexistent/ca.pem")).toThrow();
  });
});
