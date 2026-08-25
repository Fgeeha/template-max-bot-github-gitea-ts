/**
 * Общая настройка тестов.
 *
 * Тесты герметичны: в сеть не ходят, реальный токен не используют, локальный
 * .env игнорируют (config.ts сам его не грузит под vitest — см. комментарий
 * там). Кэш настроек сбрасывается вокруг каждого теста, иначе Settings,
 * созданные в одном тесте, протекали бы в следующий.
 */
import { afterEach, beforeEach } from "vitest";
import { resetSettingsCache } from "../src/config.js";

beforeEach(() => {
  resetSettingsCache();
});

afterEach(() => {
  resetSettingsCache();
});
