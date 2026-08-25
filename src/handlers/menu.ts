/** Навигация по разделам: /help, callback'и меню и разбор свободного текста. */
import type { Bot, Context } from "@maxhub/max-bot-api";
import { BackPayload, MenuPayload, PayloadError } from "../keyboards/callbacks.js";
import { backKeyboard, getSection, mainMenu } from "../keyboards/menus.js";
import { WELCOME_TEXT } from "./start.js";

export const UNKNOWN_TEXT = "Не понял запрос. Выберите раздел в меню 👇";

export function register(bot: Bot): void {
  bot.command("help", onHelp);
  bot.on("message_callback", onCallback);
  // Catch-all: регистрируется последним, иначе перехватит команды.
  bot.on("message_created", onFreeText);
}

async function onHelp(ctx: Context): Promise<void> {
  const section = getSection("help");
  const text = section?.text ?? UNKNOWN_TEXT;
  await ctx.reply(text, { attachments: [mainMenu()] });
}

/** Единая точка обработки нажатий кнопок. */
async function onCallback(ctx: Context): Promise<void> {
  if (!ctx.has("message_callback")) return;
  const payload = ctx.callback.payload ?? "";

  if (BackPayload.matches(payload)) {
    await showMainMenu(ctx);
    return;
  }

  if (!MenuPayload.matches(payload)) {
    // Payload из старой версии клавиатуры или подделанный.
    console.info(`Неизвестный payload callback: ${JSON.stringify(payload)}`);
    await ctx.answerOnCallback({ notification: "Кнопка устарела, откройте меню заново" });
    return;
  }

  let sectionId: string;
  try {
    sectionId = MenuPayload.unpack(payload).section;
  } catch (error) {
    if (error instanceof PayloadError) {
      console.warn(`Битый payload: ${error.message}`);
      await ctx.answerOnCallback({ notification: "Кнопка устарела, откройте меню заново" });
      return;
    }
    throw error;
  }

  const section = getSection(sectionId);
  if (!section || section.url) {
    // Раздел удалён из SECTIONS, либо это внешняя ссылка — у неё нет экрана внутри бота.
    await ctx.answerOnCallback({ notification: "Раздел недоступен" });
    return;
  }

  await ctx.reply(`${section.title}\n\n${section.text}`, { attachments: [backKeyboard()] });
}

/**
 * Ответ на произвольный текст.
 *
 * Здесь обычно живёт поиск или разбор пользовательского ввода. В шаблоне —
 * возврат в меню.
 */
async function onFreeText(ctx: Context): Promise<void> {
  if (!ctx.has("message_created")) return;
  // В группах на каждое сообщение не отвечаем: бот превратился бы в спамера.
  if (ctx.message.recipient.chat_type !== "dialog") return;

  await ctx.reply(UNKNOWN_TEXT, { attachments: [mainMenu()] });
}

async function showMainMenu(ctx: Context): Promise<void> {
  await ctx.reply(WELCOME_TEXT, { attachments: [mainMenu()] });
}
