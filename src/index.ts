#!/usr/bin/env node
/**
 * Точка входа бота: выбор polling / webhook по BOT_MODE.
 * Запуск: `pnpm run` (dev, без сборки) или `node dist/index.js` (после `pnpm build`).
 */
import { createServer, type Server } from "node:http";
import { Bot, Context } from "@maxhub/max-bot-api";
import type { UpdateType } from "@maxhub/max-bot-api/types";
import { getSettings, type Settings } from "./config.js";
import { registerAll } from "./handlers/index.js";
import { deleteWebhookSubscription, subscribeWebhook } from "./maxWebhookSubscription.js";
import { applyTlsCa, patchFetchForRateLimiting, RateLimiter } from "./runtime.js";
import { BackgroundDispatcher, createWebhookListener } from "./webhook.js";

// Типы апдейтов, на которые подписываемся в режиме webhook и запрашиваем в
// polling. Платформа шлёт/отдаёт только перечисленное. Добавляя хендлер на
// новый тип события, дополните список.
const WEBHOOK_UPDATE_TYPES: UpdateType[] = ["message_created", "message_callback", "bot_started"];

function buildBot(settings: Settings): Bot {
  // CA и лимиты патчат globalThis.fetch — официальный клиент не даёт своих
  // хуков (см. src/runtime.ts). Делать это нужно до первого вызова API.
  applyTlsCa(settings.maxCaBundle);
  patchFetchForRateLimiting(
    new RateLimiter(settings.maxApiRps),
    new RateLimiter(settings.maxApiMessageRps),
  );

  const bot = new Bot(settings.maxBotToken, { clientOptions: { baseUrl: settings.maxApiBaseUrl } });

  // По умолчанию официальный клиент завершает процесс на любой необработанной
  // ошибке хендлера. Здесь логируем и продолжаем — одно сломанное обновление
  // не должно ронять весь бот (тот же принцип, что и в фоновой очереди
  // вебхука, см. src/webhook.ts).
  bot.catch((error, ctx) => {
    console.error(`Необработанное исключение при обработке ${ctx.updateType}:`, error);
  });

  console.info(`MAX API URL: ${settings.maxApiBaseUrl}`);
  return bot;
}

async function registerWebhookSubscription(settings: Settings): Promise<void> {
  try {
    // Проверено в config.ts: BOT_MODE=webhook гарантирует наличие secret.
    await subscribeWebhook(
      settings.maxBotToken,
      settings.maxApiBaseUrl,
      settings.webhookUrl,
      WEBHOOK_UPDATE_TYPES,
      settings.webhookSecret as string,
    );
    console.info("Подписка на webhook зарегистрирована");
  } catch (error) {
    // Не падаем: подписка может уже существовать с прошлого запуска, а
    // сервер поднять всё равно нужно.
    console.error("Не удалось зарегистрировать webhook:", error);
  }
}

async function startWebhookServer(
  bot: Bot,
  settings: Settings,
): Promise<{ server: Server; background: BackgroundDispatcher }> {
  const background = new BackgroundDispatcher(async (raw) => {
    const ctx = new Context(raw, bot.api, bot.botInfo);
    await bot.middleware()(ctx, () => Promise.resolve(undefined));
  }, settings.webhookMaxPendingUpdates);

  const server = createServer(
    createWebhookListener(background, {
      path: settings.webhookPath,
      secret: settings.webhookSecret,
      buildTag: settings.buildTag,
    }),
  );
  // Лимиты приёма соединений: лишние лучше отбить сразу, чем держать
  // открытыми до исчерпания дескрипторов.
  server.maxConnections = settings.webhookMaxConnections;
  server.keepAliveTimeout = settings.webhookKeepaliveTimeout * 1000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      { port: settings.port, host: "0.0.0.0", backlog: settings.webhookBacklog },
      resolve,
    );
  });
  console.info(
    `Режим webhook: 0.0.0.0:${settings.port}${settings.webhookPath} ` +
      `(очередь апдейтов ${settings.webhookMaxPendingUpdates})`,
  );

  // Нужен для ctx.myId и разбора упоминаний в command()/hears() — в polling
  // это делает сам bot.start(). Best-effort и после старта сервера: сбой
  // сети здесь не должен мешать серверу принимать апдейты.
  try {
    bot.botInfo ??= await bot.api.getMyInfo();
  } catch (error) {
    console.warn("Не удалось получить информацию о боте (ctx.myId будет пуст):", error);
  }

  return { server, background };
}

async function runPolling(bot: Bot, settings: Settings): Promise<void> {
  try {
    await deleteWebhookSubscription(settings.maxBotToken, settings.maxApiBaseUrl);
  } catch (error) {
    // Подписки могло не быть — это нормально.
    console.debug("deleteWebhookSubscription пропущен:", error);
  }
  console.info("Режим polling");
  // bot.start() блокируется до bot.stop() и сам перезапускает polling-цикл
  // при сетевых сбоях (retry по умолчанию включён).
  await bot.start({ allowedUpdates: WEBHOOK_UPDATE_TYPES });
}

async function main(): Promise<void> {
  const settings = getSettings();
  console.info(
    `Старт: BOT_MODE=${settings.botMode} PROD=${settings.prod} ` +
      `DB=${settings.databaseUrl ? "on" : "off"} METRICS=${settings.metricsEnabled ? "on" : "off"} ` +
      `BUILD_TAG=${settings.buildTag || "-"}`,
  );
  if (settings.isMaintenance) {
    console.warn("PROD=false — maintenance-режим, бот отвечает только ADMIN_IDS");
  }
  if (settings.isMaintenance && settings.adminIdsSet.size === 0) {
    console.warn("ADMIN_IDS пуст в maintenance-режиме — бот не ответит никому");
  }

  if (settings.metricsEnabled) {
    const { startMetricsServer } = await import("./metrics.js");
    await startMetricsServer(settings.metricsAddr);
  }

  const bot = buildBot(settings);
  registerAll(bot);

  // Graceful shutdown: по SIGINT/SIGTERM останавливаем runner и закрываем
  // сессии, чтобы не терять апдейт «на полпути» и не оставлять соединения.
  let requestStop = (): void => {};
  const stopRequested = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  let server: Server | undefined;
  let background: BackgroundDispatcher | undefined;
  let pollingDone: Promise<void> | undefined;

  if (settings.useWebhook) {
    ({ server, background } = await startWebhookServer(bot, settings));
    await registerWebhookSubscription(settings);
  } else {
    // Если polling завершится сам (успешно или с ошибкой) — выходим тоже,
    // иначе процесс висел бы живым с мёртвым ботом.
    pollingDone = runPolling(bot, settings).finally(requestStop);
  }

  await stopRequested;
  console.info("Получен сигнал остановки, завершаюсь...");

  if (settings.useWebhook) {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  } else {
    bot.stop();
  }
  if (pollingDone) await pollingDone;

  // Сервер больше не принимает запросы — доводим до конца уже принятые
  // апдейты, иначе сообщения потерялись бы между ACK и обработкой.
  if (background) {
    await background.drain(settings.webhookDrainTimeout * 1000);
  }

  // Нет отдельного bot.close(): официальный клиент использует глобальный
  // fetch, а не собственный пул соединений — закрывать нечего.
  if (settings.databaseUrl) {
    const { disposePool } = await import("./db/pool.js");
    await disposePool();
  }
  console.info("Остановлено");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
