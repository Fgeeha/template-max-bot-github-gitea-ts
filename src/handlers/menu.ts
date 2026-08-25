import { BackPayload, MenuPayload, PayloadError } from "../keyboards/callbacks.js";
import { backKeyboard, getSection, mainMenu } from "../keyboards/menus.js";
import type { Dispatcher } from "../max/dispatcher.js";
/** Навигация по разделам: /help, callback'и меню и разбор свободного текста. */
import { command } from "../max/filters.js";
import { ChatType, type MessageCallback, type MessageCreated } from "../max/types.js";
import { WELCOME_TEXT } from "./start.js";

export const UNKNOWN_TEXT = "Не понял запрос. Выберите раздел в меню 👇";

export function register(dp: Dispatcher): void {
  dp.onMessageCreated(onHelp, command("help"));
  dp.onMessageCallback(onCallback);
  // Catch-all: регистрируется последним, иначе перехватит команды.
  dp.onMessageCreated(onFreeText);
}

async function onHelp(event: MessageCreated): Promise<void> {
  const section = getSection("help");
  const text = section?.text ?? UNKNOWN_TEXT;
  await event.message.answer({ text, attachments: [mainMenu().asMarkup()] });
}

/** Единая точка обработки нажатий кнопок. */
async function onCallback(event: MessageCallback): Promise<void> {
  const payload = event.callback.payload ?? "";

  if (BackPayload.matches(payload)) {
    await showMainMenu(event);
    return;
  }

  if (!MenuPayload.matches(payload)) {
    // Payload из старой версии клавиатуры или подделанный.
    console.info(`Неизвестный payload callback: ${JSON.stringify(payload)}`);
    await event.answer({ notification: "Кнопка устарела, откройте меню заново" });
    return;
  }

  let sectionId: string;
  try {
    sectionId = MenuPayload.unpack(payload).section;
  } catch (error) {
    if (error instanceof PayloadError) {
      console.warn(`Битый payload: ${error.message}`);
      await event.answer({ notification: "Кнопка устарела, откройте меню заново" });
      return;
    }
    throw error;
  }

  const section = getSection(sectionId);
  if (!section || section.url) {
    // Раздел удалён из SECTIONS, либо это внешняя ссылка — у неё нет экрана внутри бота.
    await event.answer({ notification: "Раздел недоступен" });
    return;
  }

  await event.message.answer({
    text: `${section.title}\n\n${section.text}`,
    attachments: [backKeyboard().asMarkup()],
  });
}

/**
 * Ответ на произвольный текст.
 *
 * Здесь обычно живёт поиск или разбор пользовательского ввода. В шаблоне —
 * возврат в меню.
 */
async function onFreeText(event: MessageCreated): Promise<void> {
  // В группах на каждое сообщение не отвечаем: бот превратился бы в спамера.
  if (event.message.recipient.chatType !== ChatType.Dialog) return;

  await event.message.answer({ text: UNKNOWN_TEXT, attachments: [mainMenu().asMarkup()] });
}

async function showMainMenu(event: MessageCallback): Promise<void> {
  await event.message.answer({ text: WELCOME_TEXT, attachments: [mainMenu().asMarkup()] });
}
