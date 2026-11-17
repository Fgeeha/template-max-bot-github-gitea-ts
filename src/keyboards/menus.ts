/**
 * Сборка клавиатур из дерева разделов.
 *
 * Разделы хранятся в БД и правятся через админку, поэтому клавиатуры
 * строятся по переданным разделам, а не по константам.
 */
import { Keyboard } from "@maxhub/max-bot-api";
import type { Button, InlineKeyboardAttachmentRequest } from "@maxhub/max-bot-api/types";
import type { Section } from "../db/models.js";
import { AdminAction, AdminPayload, SectionPayload } from "./callbacks.js";

type Row = Button[];

/** Периоды отчёта статистики, дней. */
export const STATS_PERIODS = [7, 30, 90] as const;
export const STATS_DEFAULT_DAYS = 30;

// Клавиатура MAX вмещает до 30 рядов. Под кнопки админки уходит до 6 рядов,
// у пользователя — один ряд «Назад»; остальное отдаём подразделам.
export const MAX_CHILDREN = 24;
export const BACK_TEXT = "◀️ Назад";
/** Потолок длины подписи кнопки в MAX. */
const BUTTON_TEXT_MAX = 64;

function keyboard(rows: Row[]): InlineKeyboardAttachmentRequest {
  return Keyboard.inlineKeyboard(rows);
}

function button(text: string, action: AdminAction, target = 0): Button {
  return Keyboard.button.callback(text, new AdminPayload(action, target).pack());
}

/**
 * Кнопки подразделов, каждая своей строкой, и «Назад» к родителю.
 *
 * «Назад» — обычная кнопка раздела-родителя (`s:<parentId>`), отдельный
 * обработчик не нужен. У главного меню её нет; undefined — кнопок нет совсем.
 */
export function sectionKeyboard(
  section: Section,
  children: readonly Section[],
): InlineKeyboardAttachmentRequest | undefined {
  if (children.length === 0 && section.parentId === null) return undefined;
  const rows: Row[] = children.map((child) => [
    // Ссылку открывает клиент MAX — бот нажатия не получает.
    child.url
      ? Keyboard.button.link(child.title, child.url)
      : Keyboard.button.callback(child.title, new SectionPayload(child.id).pack()),
  ]);
  if (section.parentId !== null) {
    rows.push([Keyboard.button.callback(BACK_TEXT, new SectionPayload(section.parentId).pack())]);
  }
  return keyboard(rows);
}

/** Одна кнопка-ссылка раздела — для предпросмотра в админке. */
export function linkKeyboard(section: Section): InlineKeyboardAttachmentRequest {
  return keyboard([[Keyboard.button.link(section.title, section.url ?? "")]]);
}

/** Экран раздела в админке: подразделы и действия над разделом. */
export function adminKeyboard(
  section: Section,
  children: readonly Section[],
): InlineKeyboardAttachmentRequest {
  // В админке и раздел-ссылка открывается экраном правки, а не сайтом.
  const rows: Row[] = children.map((child) => [
    button(
      [...(child.url ? `🔗 ${child.title}` : child.title)].slice(0, BUTTON_TEXT_MAX).join(""),
      AdminAction.Open,
      child.id,
    ),
  ]);
  rows.push([button("➕ Добавить подраздел", AdminAction.Add, section.id)]);
  if (section.parentId === null) {
    rows.push([
      button("📝 Текст", AdminAction.Text, section.id),
      button("🖼 Картинка", AdminAction.Image, section.id),
    ]);
    // Инструменты — одним рядом: 24 подраздела + 4 ряда корня = 28 из 30.
    rows.push([
      button("👥 Админы", AdminAction.Staff),
      button("📊 Статистика", AdminAction.Stats, STATS_DEFAULT_DAYS),
      button("📦 Файл", AdminAction.Transfer),
      button("📜 Журнал", AdminAction.Log),
    ]);
    rows.push([button("👁 Как видит пользователь", AdminAction.Preview, section.id)]);
    return keyboard(rows);
  }
  // Все правки — одним рядом: при 24 подразделах рядов ровно 30, предел MAX.
  rows.push([
    button("✏️ Название", AdminAction.Title, section.id),
    button("📝 Текст", AdminAction.Text, section.id),
    button("🖼 Картинка", AdminAction.Image, section.id),
    button("🔗 Ссылка", AdminAction.Link, section.id),
  ]);
  rows.push([
    button("⬆️ Выше", AdminAction.Up, section.id),
    button("⬇️ Ниже", AdminAction.Down, section.id),
  ]);
  rows.push([button("👁 Как видит пользователь", AdminAction.Preview, section.id)]);
  rows.push([button("🗑 Удалить", AdminAction.Delete, section.id)]);
  rows.push([button(BACK_TEXT, AdminAction.Open, section.parentId)]);
  return keyboard(rows);
}

export function confirmDeleteKeyboard(section: Section): InlineKeyboardAttachmentRequest {
  return keyboard([
    [
      button("✅ Да, удалить", AdminAction.DeleteConfirm, section.id),
      button("❌ Отмена", AdminAction.Open, section.id),
    ],
  ]);
}

/** Кнопка отмены ввода: возвращает на экран и снимает ожидание. */
export function cancelKeyboard(
  sectionId = 0,
  action: AdminAction = AdminAction.Open,
): InlineKeyboardAttachmentRequest {
  return keyboard([[button("❌ Отмена", action, sectionId)]]);
}

/** Ряд «Назад» на главный экран админки. */
function homeRow(): Row {
  return [button(BACK_TEXT, AdminAction.Home)];
}

export function homeKeyboard(): InlineKeyboardAttachmentRequest {
  return keyboard([homeRow()]);
}

/** Список администраторов; править его может только владелец. */
export function staffKeyboard(
  staffIds: readonly number[],
  canEdit: boolean,
): InlineKeyboardAttachmentRequest {
  const rows: Row[] = [];
  if (canEdit) {
    for (const userId of staffIds.slice(0, MAX_CHILDREN)) {
      rows.push([button(`🗑 ${userId}`, AdminAction.StaffDel, userId)]);
    }
    rows.push([button("➕ Добавить администратора", AdminAction.StaffAdd)]);
  }
  rows.push(homeRow());
  return keyboard(rows);
}

export function confirmStaffDeleteKeyboard(userId: number): InlineKeyboardAttachmentRequest {
  return keyboard([
    [
      button("✅ Да, отозвать", AdminAction.StaffDelConfirm, userId),
      button("❌ Отмена", AdminAction.Staff),
    ],
  ]);
}

export function statsKeyboard(): InlineKeyboardAttachmentRequest {
  return keyboard([STATS_PERIODS.map((d) => button(`${d} дн.`, AdminAction.Stats, d)), homeRow()]);
}

export function transferKeyboard(): InlineKeyboardAttachmentRequest {
  return keyboard([
    [button("⬇️ Скачать", AdminAction.Export), button("⬆️ Загрузить", AdminAction.Import)],
    homeRow(),
  ]);
}
