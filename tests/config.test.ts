/** Проверки разбора и валидации настроек. */
import { describe, expect, it } from "vitest";
import { BotMode } from "../src/config.js";
import { withEnv } from "./helpers/env.js";

describe("config", () => {
  it("незаданный PROD оставляет бота закрытым, а режим — polling", () => {
    const settings = withEnv({ PROD: "false" });
    expect(settings.botMode).toBe(BotMode.Polling);
    expect(settings.isMaintenance).toBe(true);
    expect(settings.useWebhook).toBe(false);
  });

  it("разбирает список admin id", () => {
    const settings = withEnv({ ADMIN_IDS: " 123, 456 ,789 " });
    expect(settings.adminIdsSet).toEqual(new Set([123, 456, 789]));
  });

  it("мусор в списке не роняет старт — просто не попадает в множество", () => {
    const settings = withEnv({ ADMIN_IDS: "123, abc, , -5, 456" });
    expect(settings.adminIdsSet).toEqual(new Set([123, 456]));
  });

  it("webhook без WEBHOOK_HOST запрещён", () => {
    expect(() => withEnv({ BOT_MODE: "webhook", WEBHOOK_SECRET: "s".repeat(32) })).toThrow(
      /WEBHOOK_HOST/,
    );
  });

  it("webhook без WEBHOOK_SECRET запрещён — открытый эндпоинт без аутентификации", () => {
    expect(() => withEnv({ BOT_MODE: "webhook", WEBHOOK_HOST: "https://bot.example.ru" })).toThrow(
      /WEBHOOK_SECRET/,
    );
  });

  it("webhookUrl собирается из частей без лишних/пропущенных слешей", () => {
    const settings = withEnv({
      BOT_MODE: "webhook",
      WEBHOOK_HOST: "https://bot.example.ru/",
      WEBHOOK_PATH: "hook",
      WEBHOOK_SECRET: "s".repeat(32),
    });
    expect(settings.webhookUrl).toBe("https://bot.example.ru/hook");
  });

  it("без DATABASE_URL бот не стартует — разделы живут в БД", () => {
    expect(() => withEnv({ DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });

  it("DSN не Postgres отклоняется", () => {
    expect(() => withEnv({ DATABASE_URL: "mysql://bot:bot@db/bot" })).toThrow(/DATABASE_URL/);
  });

  it("статистика включена по умолчанию, смещение времени — МСК", () => {
    const settings = withEnv();
    expect(settings.statsEnabled).toBe(true);
    expect(settings.displayUtcOffset).toBe(3);
  });

  it("принимает обычный Postgres DSN", () => {
    const settings = withEnv({ DATABASE_URL: "postgresql://bot:bot@db:5432/bot" });
    expect(settings.databaseUrl).toBeTruthy();
  });
});
