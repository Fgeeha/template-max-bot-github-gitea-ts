/**
 * Приветствие: команда /start и системное событие bot_started.
 *
 * Текст приветствия и кнопки главного меню — корневой раздел в БД, правится
 * через /admin.
 */
import type { Context } from "@maxhub/max-bot-api";
import { isDialog, userIdOf } from "./admin.js";
import type { Dispatcher } from "./index.js";
import { sendRoot } from "./menu.js";

export function register(bot: Dispatcher): void {
  bot.command("start", sendRoot);
  bot.command("id", onIdCommand);
  // bot_started приходит при первом открытии диалога — до того, как
  // пользователь что-либо отправит. Без этого хендлера первый экран пустой.
  bot.on("bot_started", sendRoot);
}

/** Свой MAX user ID — его владелец вводит, добавляя администратора. */
async function onIdCommand(ctx: Context): Promise<void> {
  const userId = userIdOf(ctx);
  if (userId === undefined || !isDialog(ctx)) return;
  await ctx.reply(`Ваш MAX user ID: ${userId}`);
}
