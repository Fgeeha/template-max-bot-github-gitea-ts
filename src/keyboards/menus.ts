/**
 * Сборка клавиатур из описания разделов.
 *
 * Разделы заданы данными, а не кодом: чтобы добавить пункт меню, достаточно
 * дописать запись в SECTIONS — клавиатура и обработчик подхватят её сами.
 */
import { Keyboard } from "@maxhub/max-bot-api";
import type { InlineKeyboardAttachmentRequest } from "@maxhub/max-bot-api/types";
import { BackPayload, MenuPayload } from "./callbacks.js";

export interface Section {
  id: string;
  title: string;
  /** url задан — кнопка ведёт наружу (LinkButton), текст не нужен. */
  url?: string;
  /** url пуст — кнопка callback, бот покажет text и кнопку «Назад». */
  text?: string;
}

// Демонстрационное наполнение — замените разделами своего бота.
export const SECTIONS: readonly Section[] = [
  {
    id: "about",
    title: "ℹ️ О боте",
    text: "Шаблон бота для мессенджера MAX.\n\nЗдесь описано, что умеет бот и как им пользоваться.",
  },
  {
    id: "help",
    title: "❓ Помощь",
    text: "Доступные команды:\n/start — главное меню\n/help — эта справка\n\nКнопки под сообщением ведут по разделам.",
  },
  {
    id: "site",
    title: "🌐 Сайт",
    url: "https://max.ru",
  },
];

const SECTIONS_BY_ID = new Map(SECTIONS.map((section) => [section.id, section]));

export function getSection(sectionId: string): Section | undefined {
  return SECTIONS_BY_ID.get(sectionId);
}

/** Главное меню: по кнопке на раздел, каждая — своей строкой. */
export function mainMenu(): InlineKeyboardAttachmentRequest {
  return Keyboard.inlineKeyboard(
    SECTIONS.map((section) => [
      section.url
        ? Keyboard.button.link(section.title, section.url)
        : Keyboard.button.callback(section.title, new MenuPayload(section.id).pack()),
    ]),
  );
}

/** Одиночная кнопка возврата в главное меню. */
export function backKeyboard(): InlineKeyboardAttachmentRequest {
  return Keyboard.inlineKeyboard([[Keyboard.button.callback("◀️ Назад", new BackPayload().pack())]]);
}
