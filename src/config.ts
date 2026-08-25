/**
 * Конфигурация бота: единый источник правды для всех настроек.
 *
 * Все параметры читаются из переменных окружения (или из .env в корне
 * проекта). Хардкод значений в коде запрещён — добавляя настройку, объявляйте
 * её здесь и описывайте в .env.example.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Абсолютный путь к .env от корня проекта (src/config.ts → ../.env).
// Относительный путь искал бы файл от cwd процесса — ненадёжно при запуске
// не из корня. В Docker .env не монтируется: переменные приходят через
// docker-compose env_file уже как переменные окружения.
const ENV_FILE = path.resolve(__dirname, "..", ".env");

// Тесты задают переменные окружения напрямую (см. tests/setup.ts) — если
// подмешать сюда ещё и локальный .env разработчика, тесты перестанут быть
// герметичными и будут падать только у того, чей .env заполнен иначе. Vitest
// сам выставляет VITEST=true в процессе, поэтому .env под тестами не грузим.
if (!process.env.VITEST && existsSync(ENV_FILE)) {
  loadDotenv({ path: ENV_FILE, override: false });
}

export enum BotMode {
  Polling = "polling",
  Webhook = "webhook",
}

/** Преобразует "true"/"false" строки из окружения в boolean (Boolean("false") иначе даёт true). */
function boolFromEnv() {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const lower = value.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
    return value;
  }, z.boolean());
}

const envSchema = z.object({
  // ---- Платформа MAX -------------------------------------------------------
  MAX_BOT_TOKEN: z.string().min(1, "MAX_BOT_TOKEN обязателен"),
  MAX_API_BASE_URL: z.string().default("https://platform-api2.max.ru"),
  MAX_CA_BUNDLE: z.string().optional(),
  MAX_API_RPS: z.coerce.number().int().positive().default(25),
  MAX_API_MESSAGE_RPS: z.coerce.number().int().positive().default(2),

  // ---- Режим работы ---------------------------------------------------------
  BOT_MODE: z.nativeEnum(BotMode).default(BotMode.Polling),
  WEBHOOK_HOST: z.string().optional(),
  WEBHOOK_PATH: z.string().default("/webhook"),
  WEBHOOK_SECRET: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(8081),
  WEBHOOK_MAX_PENDING_UPDATES: z.coerce.number().int().positive().default(500),
  WEBHOOK_DRAIN_TIMEOUT: z.coerce.number().positive().default(20),
  WEBHOOK_MAX_CONNECTIONS: z.coerce.number().int().positive().default(256),
  WEBHOOK_BACKLOG: z.coerce.number().int().positive().default(256),
  WEBHOOK_KEEPALIVE_TIMEOUT: z.coerce.number().int().positive().default(5),

  // ---- Логирование ----------------------------------------------------------
  LOG_LEVEL: z.string().default("info"),

  // ---- Доступ -----------------------------------------------------------------
  PROD: boolFromEnv().default(false),
  ADMIN_IDS: z.string().default(""),

  // ---- Хранилище (опционально) -----------------------------------------------
  DATABASE_URL: z.string().optional(),

  // ---- Метрики (опционально) ---------------------------------------------------
  METRICS_ENABLED: boolFromEnv().default(false),
  METRICS_ADDR: z.string().default(":9090"),

  // ---- Служебное ----------------------------------------------------------------
  BUILD_TAG: z.string().default(""),
});

type EnvShape = z.infer<typeof envSchema>;

export class Settings {
  readonly maxBotToken: string;
  readonly maxApiBaseUrl: string;
  readonly maxCaBundle: string | undefined;
  readonly maxApiRps: number;
  readonly maxApiMessageRps: number;

  readonly botMode: BotMode;
  readonly webhookHost: string | undefined;
  readonly webhookPath: string;
  readonly webhookSecret: string | undefined;
  readonly port: number;
  readonly webhookMaxPendingUpdates: number;
  readonly webhookDrainTimeout: number;
  readonly webhookMaxConnections: number;
  readonly webhookBacklog: number;
  readonly webhookKeepaliveTimeout: number;

  readonly logLevel: string;

  readonly prod: boolean;
  readonly adminIds: string;

  readonly databaseUrl: string | undefined;

  readonly metricsEnabled: boolean;
  readonly metricsAddr: string;

  readonly buildTag: string;

  private constructor(env: EnvShape) {
    this.maxBotToken = env.MAX_BOT_TOKEN;
    this.maxApiBaseUrl = env.MAX_API_BASE_URL;
    this.maxCaBundle = env.MAX_CA_BUNDLE;
    this.maxApiRps = env.MAX_API_RPS;
    this.maxApiMessageRps = env.MAX_API_MESSAGE_RPS;

    this.botMode = env.BOT_MODE;
    this.webhookHost = env.WEBHOOK_HOST;
    this.webhookPath = env.WEBHOOK_PATH;
    this.webhookSecret = env.WEBHOOK_SECRET;
    this.port = env.PORT;
    this.webhookMaxPendingUpdates = env.WEBHOOK_MAX_PENDING_UPDATES;
    this.webhookDrainTimeout = env.WEBHOOK_DRAIN_TIMEOUT;
    this.webhookMaxConnections = env.WEBHOOK_MAX_CONNECTIONS;
    this.webhookBacklog = env.WEBHOOK_BACKLOG;
    this.webhookKeepaliveTimeout = env.WEBHOOK_KEEPALIVE_TIMEOUT;

    this.logLevel = env.LOG_LEVEL;

    this.prod = env.PROD;
    this.adminIds = env.ADMIN_IDS;

    this.databaseUrl = env.DATABASE_URL;

    this.metricsEnabled = env.METRICS_ENABLED;
    this.metricsAddr = env.METRICS_ADDR;

    this.buildTag = env.BUILD_TAG;

    this.validateWebhook();
  }

  /** Запрещает заведомо сломанную конфигурацию webhook — ошибка на старте лучше, чем открытый эндпоинт без аутентификации. */
  private validateWebhook(): void {
    if (this.botMode !== BotMode.Webhook) return;
    if (!this.webhookHost) {
      throw new Error(
        "BOT_MODE=webhook требует WEBHOOK_HOST (публичный https-адрес без пути, напр. https://bot.example.ru).",
      );
    }
    if (!this.webhookSecret) {
      throw new Error(
        "BOT_MODE=webhook задан без WEBHOOK_SECRET — публичный эндпоинт принимал бы любые запросы " +
          "без проверки подлинности. Сгенерируйте секрет: openssl rand -hex 32",
      );
    }
  }

  get useWebhook(): boolean {
    return this.botMode === BotMode.Webhook;
  }

  /** True, если бот отвечает только администраторам. */
  get isMaintenance(): boolean {
    return !this.prod;
  }

  /** Разобранное множество admin user_id из ADMIN_IDS. */
  get adminIdsSet(): ReadonlySet<number> {
    const result = new Set<number>();
    for (const part of this.adminIds.split(",")) {
      const trimmed = part.trim();
      if (/^\d+$/.test(trimmed)) result.add(Number(trimmed));
    }
    return result;
  }

  /** Полный URL подписки: WEBHOOK_HOST + WEBHOOK_PATH. */
  get webhookUrl(): string {
    if (!this.webhookHost) throw new Error("WEBHOOK_HOST не задан");
    const base = this.webhookHost.replace(/\/+$/, "");
    const suffix = this.webhookPath.startsWith("/") ? this.webhookPath : `/${this.webhookPath}`;
    return `${base}${suffix}`;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Settings {
    return new Settings(envSchema.parse(env));
  }
}

let cached: Settings | undefined;

/**
 * Возвращает singleton настроек.
 *
 * Ленивое создание (в отличие от модульной константы) позволяет тестам
 * подменить переменные окружения до первого обращения и сбросить кэш через
 * resetSettingsCache().
 */
export function getSettings(): Settings {
  if (!cached) {
    cached = Settings.fromEnv();
  }
  return cached;
}

export function resetSettingsCache(): void {
  cached = undefined;
}
