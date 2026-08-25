/** Приветствие: команда /start и системное событие bot_started. */
import type { Bot, Context } from "@maxhub/max-bot-api";
import { mainMenu } from "../keyboards/menus.js";

export const WELCOME_TEXT = `👋 Здравствуйте!

Это шаблон бота для мессенджера MAX.
Замените этот текст описанием своего бота.

Выберите раздел 👇
`;

export function register(bot: Bot): void {
  bot.command("start", showWelcome);
  // bot_started приходит при первом открытии диалога — до того, как
  // пользователь что-либо отправит. Без этого хендлера первый экран пустой.
  bot.on("bot_started", showWelcome);
}

async function showWelcome(ctx: Context): Promise<void> {
  await ctx.reply(WELCOME_TEXT, { attachments: [mainMenu()] });
}
