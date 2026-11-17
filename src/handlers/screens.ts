/** Экраны админки разделов: текст и клавиатура, подписи для журнала. */
import type { Context } from "@maxhub/max-bot-api";
import type { InlineKeyboardAttachmentRequest } from "@maxhub/max-bot-api/types";
import type { Section } from "../db/models.js";
import type { SectionRepository } from "../db/repositories/sections.js";
import { AdminAction } from "../keyboards/callbacks.js";
import { adminKeyboard } from "../keyboards/menus.js";
import { charLength, charSlice } from "./inputs.js";
import { showInPlace } from "./menu.js";

// Сколько текста раздела показывать на экране админки: экран — тоже
// сообщение, и вместе с шапкой должен уложиться в 4000.
export const SCREEN_TEXT_PREVIEW = 3000;

export interface AdminScreen {
  text: string;
  keyboard: InlineKeyboardAttachmentRequest;
}

/** Экран админки на месте сообщения с нажатой кнопкой. */
export function showAdminScreen(
  ctx: Context,
  screen: AdminScreen,
  notification?: string,
): Promise<void> {
  return showInPlace(ctx, { text: screen.text, attachments: [screen.keyboard] }, notification);
}

function shorten(text: string, limit: number): string {
  return charLength(text) > limit ? `${charSlice(text, limit)}…` : text;
}

/** Экран раздела в админке. */
export async function buildScreen(repo: SectionRepository, section: Section): Promise<AdminScreen> {
  const path = await repo.path(section);
  const children = await repo.children(section.id);
  const body = shorten(section.text.trim() || "— не задан —", SCREEN_TEXT_PREVIEW);

  const lines = ["⚙️ Админка", `📂 ${path.map((s) => s.title).join(" › ")}`, ""];
  if (section.parentId === null) {
    lines.push("📝 Приветствие на /start:");
  } else {
    const siblings = await repo.children(section.parentId);
    const index = siblings.findIndex((s) => s.id === section.id);
    lines.splice(2, 0, `Позиция кнопки: ${index + 1} из ${siblings.length}`);
    if (section.url) {
      // Текст и подразделы сохраняются: уберут ссылку — вернутся. Ссылку
      // укорачиваем: экран вместе с текстом должен влезть в 4000.
      lines.push(
        `🔗 Кнопка открывает ссылку: ${shorten(section.url, 200)}`,
        "Текст и подразделы пользователь не видит, пока ссылка задана.",
        "",
        "📝 Текст (сохранён, вернётся, если убрать ссылку):",
      );
    } else {
      lines.push("📝 Текст, который придёт по кнопке:");
    }
  }
  lines.push(
    body,
    "",
    `🖼 Картинка: ${imageStatus(section)}`,
    `Подразделов (кнопок под текстом): ${children.length}`,
  );
  return { text: lines.join("\n"), keyboard: adminKeyboard(section, children) };
}

function imageStatus(section: Section): string {
  if (!section.imageToken) return "нет";
  // У раздела-ссылки нет экрана — картинку пользователь не увидит.
  if (section.url) return "сохранена, появится, если убрать ссылку";
  return "есть — видна в «👁 Как видит пользователь»";
}

export function name(section: Section): string {
  return `«${section.title}» #${section.id}`;
}

/** Строка журнала для правки через ввод. */
export function auditText(action: AdminAction, section: Section, oldTitle: string): string {
  switch (action) {
    case AdminAction.Add:
      return `добавил раздел ${name(section)}`;
    case AdminAction.Title:
      return `переименовал «${oldTitle}» → ${name(section)}`;
    case AdminAction.Link:
      return `${section.url ? "задал" : "убрал"} ссылку ${name(section)}`;
    case AdminAction.Image:
      return `${section.imageToken ? "сменил" : "убрал"} картинку ${name(section)}`;
    default:
      return `изменил текст ${name(section)}`;
  }
}
