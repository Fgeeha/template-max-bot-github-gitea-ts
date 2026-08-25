/** Проверки ограничения частоты событий по пользователю. */
import { describe, expect, it } from "vitest";
import type { UpdateEvent } from "../src/max/types.js";
import { ThrottlingMiddleware } from "../src/middlewares/throttling.js";

function fakeEvent(userId: number | undefined): UpdateEvent {
  return {
    getIds: () => (userId === undefined ? undefined : { userId }),
  } as unknown as UpdateEvent;
}

describe("ThrottlingMiddleware", () => {
  it("пропускает первое событие", async () => {
    const middleware = new ThrottlingMiddleware(10);
    let called = false;
    await middleware.handle(async () => {
      called = true;
    }, fakeEvent(1));
    expect(called).toBe(true);
  });

  it("блокирует второе событие того же пользователя", async () => {
    const middleware = new ThrottlingMiddleware(10);
    await middleware.handle(async () => {}, fakeEvent(1));
    let called = false;
    await middleware.handle(async () => {
      called = true;
    }, fakeEvent(1));
    expect(called).toBe(false);
  });

  it("лимит персональный: активный пользователь не блокирует остальных", async () => {
    const middleware = new ThrottlingMiddleware(10);
    await middleware.handle(async () => {}, fakeEvent(1));
    let called = false;
    await middleware.handle(async () => {
      called = true;
    }, fakeEvent(2));
    expect(called).toBe(true);
  });

  it("системные события без user_id пропускает без ограничений", async () => {
    const middleware = new ThrottlingMiddleware(10);
    let calls = 0;
    await middleware.handle(async () => {
      calls += 1;
    }, fakeEvent(undefined));
    await middleware.handle(async () => {
      calls += 1;
    }, fakeEvent(undefined));
    expect(calls).toBe(2);
  });

  it("истёкший лимит не блокирует", async () => {
    const middleware = new ThrottlingMiddleware(0);
    await middleware.handle(async () => {}, fakeEvent(1));
    let called = false;
    await middleware.handle(async () => {
      called = true;
    }, fakeEvent(1));
    expect(called).toBe(true);
  });
});
