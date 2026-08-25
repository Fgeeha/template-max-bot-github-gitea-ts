/** Проверки служебных команд и форматирования сообщений. */
import { describe, expect, it } from "vitest";
import { buildStatusText, MAX_MESSAGE_LEN, splitMessage } from "../src/handlers/admin.js";
import { withEnv } from "./helpers/env.js";

describe("admin handler", () => {
  it("короткий текст не режется", () => {
    expect(splitMessage("короткий текст")).toEqual(["короткий текст"]);
  });

  it("длинный текст режется в пределах лимита", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `строка номер ${i}`).join("\n");
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
  });

  it("разбиение не теряет и не дублирует строки", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `строка ${i}`);
    const chunks = splitMessage(lines.join("\n"));
    expect(chunks.join("\n").split("\n")).toEqual(lines);
  });

  it("разбиение не рвёт строки посередине", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `строка ${i}`);
    for (const chunk of splitMessage(lines.join("\n"))) {
      for (const line of chunk.split("\n")) {
        expect(lines).toContain(line);
      }
    }
  });

  it("отчёт о статусе не раскрывает токен или пароль от БД", () => {
    withEnv({
      MAX_BOT_TOKEN: "super-secret-token",
      DATABASE_URL: "postgresql://bot:secret-password@db:5432/bot",
    });
    const text = buildStatusText();
    expect(text).not.toContain("super-secret-token");
    expect(text).not.toContain("secret-password");
    expect(text).toContain("подключена");
  });
});
