#!/usr/bin/env node
/**
 * Точка входа бота: выбор polling / webhook по BOT_MODE.
 * Запуск: `pnpm run` (dev, без сборки) или `node dist/index.js` (после `pnpm build`).
 */
import { type Server, createServer } from "node:http";
import { type Settings, getSettings } from "./config.js";
import { registerAll } from "./handlers/index.js";
import { Bot } from "./max/bot.js";
import { Dispatcher } from "./max/dispatcher.js";
import { UpdateType } from "./max/types.js";
import { RateLimiter, buildTlsCa } from "./runtime.js";
import { BackgroundDispatcher, createWebhookListener } from "./webhook.js";

// Типы апдейтов, на которые подписываемся в режиме webhook. В polling
// getUpdates отдаёт всё подряд; здесь список нужен явный — платформа шлёт
// только перечисленное. Добавляя хендлер на новый тип события, дополните.
const WEBHOOK_UPDATE_TYPES = [
  UpdateType.MessageCreated,
  UpdateType.MessageCallback,
  UpdateType.BotStarted,
];

function buildBot(settings: Settings): Bot {
  const bot = new Bot({
    token: settings.maxBotToken,
    baseUrl: settings.maxApiBaseUrl,
    ca: buildTlsCa(settings.maxCaBundle),
    apiRateLimiter: new RateLimiter(settings.maxApiRps),
    messageRateLimiter: new RateLimiter(settings.maxApiMessageRps),
  });
  console.info(`MAX API URL: ${settings.maxApiBaseUrl}`);
  return bot;
}

function buildDispatcher(): Dispatcher {
  const dispatcher = new Dispatcher();
  registerAll(dispatcher);
  return dispatcher;
}

async function registerWebhookSubscription(bot: Bot, settings: Settings): Promise<void> {
  try {
    // Проверено в config.ts: BOT_MODE=webhook гарантирует наличие secret.
    await bot.subscribeWebhook(
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
  dispatcher: Dispatcher,
  settings: Settings,
): Promise<{ server: Server; background: BackgroundDispatcher }> {
  const background = new BackgroundDispatcher(
    (raw) => dispatcher.dispatch(bot, raw),
    settings.webhookMaxPendingUpdates,
  );
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
  return { server, background };
}

async function runPolling(bot: Bot, dispatcher: Dispatcher): Promise<void> {
  try {
    await bot.deleteWebhook();
  } catch (error) {
    // Подписки могло не быть — это нормально.
    console.debug("deleteWebhook пропущен:", error);
  }
  console.info("Режим polling");
  await dispatcher.startPolling(bot);
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
  const dispatcher = buildDispatcher();

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
    ({ server, background } = await startWebhookServer(bot, dispatcher, settings));
    await registerWebhookSubscription(bot, settings);
  } else {
    // Если polling завершится сам (успешно или с ошибкой) — выходим тоже,
    // иначе процесс висел бы живым с мёртвым ботом.
    pollingDone = runPolling(bot, dispatcher).finally(requestStop);
  }

  await stopRequested;
  console.info("Получен сигнал остановки, завершаюсь...");

  if (settings.useWebhook) {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  } else {
    dispatcher.stopPolling();
  }
  if (pollingDone) await pollingDone;

  // Сервер больше не принимает запросы — доводим до конца уже принятые
  // апдейты, иначе сообщения потерялись бы между ACK и обработкой.
  if (background) {
    await background.drain(settings.webhookDrainTimeout * 1000);
  }

  await bot.close();
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
