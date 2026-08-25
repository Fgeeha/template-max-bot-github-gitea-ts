/** Помощник для тестов конфигурации: задаёт переменные окружения так же, как это делает прод. */
import { Settings, resetSettingsCache } from "../../src/config.js";

const ENV_KEYS = [
  "MAX_BOT_TOKEN",
  "MAX_API_BASE_URL",
  "MAX_CA_BUNDLE",
  "MAX_API_RPS",
  "MAX_API_MESSAGE_RPS",
  "BOT_MODE",
  "WEBHOOK_HOST",
  "WEBHOOK_PATH",
  "WEBHOOK_SECRET",
  "PORT",
  "WEBHOOK_MAX_PENDING_UPDATES",
  "WEBHOOK_DRAIN_TIMEOUT",
  "WEBHOOK_MAX_CONNECTIONS",
  "WEBHOOK_BACKLOG",
  "WEBHOOK_KEEPALIVE_TIMEOUT",
  "LOG_LEVEL",
  "PROD",
  "ADMIN_IDS",
  "DATABASE_URL",
  "METRICS_ENABLED",
  "METRICS_ADDR",
  "BUILD_TAG",
] as const;

const BASE_ENV: Record<string, string> = {
  MAX_BOT_TOKEN: "test-token",
  PROD: "true",
  ADMIN_IDS: "",
};

/** Полностью очищает известные переменные окружения бота и задаёт их заново из overrides. */
export function withEnv(overrides: Record<string, string> = {}): Settings {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    process.env[key] = value;
  }
  resetSettingsCache();
  return Settings.fromEnv();
}
