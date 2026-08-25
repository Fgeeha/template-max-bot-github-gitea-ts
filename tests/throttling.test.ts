/** Проверки ограничения частоты событий по пользователю. */
import type { Context } from "@maxhub/max-bot-api";
import { describe, expect, it } from "vitest";
import { ThrottlingMiddleware } from "../src/middlewares/throttling.js";

function fakeCtx(userId: number | undefined): Context {
  return {
    user: userId === undefined ? undefined : { user_id: userId },
    has: () => false,
  } as unknown as Context;
}

describe("ThrottlingMiddleware", () => {
  it("пропускает первое событие", async () => {
    const middleware = new ThrottlingMiddleware(10);
    let called = false;
    await middleware.handle(fakeCtx(1), async () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it("блокирует второе событие того же пользователя", async () => {
    const middleware = new ThrottlingMiddleware(10);
    await middleware.handle(fakeCtx(1), async () => {});
    let called = false;
    await middleware.handle(fakeCtx(1), async () => {
      called = true;
    });
    expect(called).toBe(false);
  });

  it("лимит персональный: активный пользователь не блокирует остальных", async () => {
    const middleware = new ThrottlingMiddleware(10);
    await middleware.handle(fakeCtx(1), async () => {});
    let called = false;
    await middleware.handle(fakeCtx(2), async () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it("системные события без user_id пропускает без ограничений", async () => {
    const middleware = new ThrottlingMiddleware(10);
    let calls = 0;
    await middleware.handle(fakeCtx(undefined), async () => {
      calls += 1;
    });
    await middleware.handle(fakeCtx(undefined), async () => {
      calls += 1;
    });
    expect(calls).toBe(2);
  });

  it("истёкший лимит не блокирует", async () => {
    const middleware = new ThrottlingMiddleware(0);
    await middleware.handle(fakeCtx(1), async () => {});
    let called = false;
    await middleware.handle(fakeCtx(1), async () => {
      called = true;
    });
    expect(called).toBe(true);
  });
});
