import { mainMenu } from "../keyboards/menus.js";
import type { Dispatcher } from "../max/dispatcher.js";
/** Приветствие: команда /start и системное событие bot_started. */
import { commandStart } from "../max/filters.js";
import type { BotStarted, MessageCreated } from "../max/types.js";

export const WELCOME_TEXT = `👋 Здравствуйте!

Это шаблон бота для мессенджера MAX.
Замените этот текст описанием своего бота.

Выберите раздел 👇
`;

export function register(dp: Dispatcher): void {
  dp.onMessageCreated(onStartCommand, commandStart());
  // bot_started приходит при первом открытии диалога — до того, как
  // пользователь что-либо отправит. Без этого хендлера первый экран пустой.
  dp.onBotStarted(onBotStarted);
}

async function onStartCommand(event: MessageCreated): Promise<void> {
  await event.message.answer({ text: WELCOME_TEXT, attachments: [mainMenu().asMarkup()] });
}

async function onBotStarted(event: BotStarted): Promise<void> {
  // Отвечать некуда — сообщения ещё нет, поэтому пишем напрямую пользователю.
  await event.bot.sendMessageToUser({
    userId: event.userId,
    text: WELCOME_TEXT,
    attachments: [mainMenu().asMarkup()],
  });
}
