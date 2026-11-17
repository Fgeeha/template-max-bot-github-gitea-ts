/** Навигация пользователя по разделам: кнопки и свободный текст. */
import { type Context, MaxError } from "@maxhub/max-bot-api";
import type { AttachmentRequest } from "@maxhub/max-bot-api/types";
import { getSettings } from "../config.js";
import type { Section } from "../db/models.js";
import { type Queryable, withTransaction } from "../db/pool.js";
import { SectionRepository } from "../db/repositories/sections.js";
import { StatsRepository, userHash } from "../db/repositories/stats.js";
import { PayloadError, SectionPayload } from "../keyboards/callbacks.js";
import { sectionKeyboard } from "../keyboards/menus.js";
import { isAdmin, isDialog, userIdOf } from "./admin.js";
import type { Dispatcher } from "./index.js";

export const STALE_TEXT = "Раздел больше недоступен — открываю главное меню";

/** Вложения экрана: картинка раздела (если есть) и клавиатура. */
export type Attachments = AttachmentRequest[];
export interface Screen {
  text: string;
  attachments: Attachments;
}
/** Способ доставить экран: ответ в чат, правка сообщения, личное сообщение. */
export type Send = (text: string, attachments: Attachments) => Promise<unknown>;

export function register(bot: Dispatcher): void {
  bot.on("message_callback", onCallback);
  // Catch-all: регистрируется последним, иначе перехватит команды.
  bot.on("message_created", onFreeText);
}

/** Сообщение раздела так, как его видит пользователь. Пустой текст MAX не отправит — тогда название. */
export function renderSection(section: Section, children: readonly Section[]): Screen {
  const attachments: Attachments = [];
  if (section.imageToken) attachments.push(imageAttachment(section.imageToken));
  const keyboard = sectionKeyboard(section, children);
  if (keyboard) attachments.push(keyboard);
  return { text: section.text.trim() || section.title, attachments };
}

/**
 * Главное меню: приветствие и кнопки разделов верхнего уровня.
 *
 * В статистику не попадает: меню показывается на любой текст, /start и
 * устаревшую кнопку — считались бы ответы бота, а не интерес к разделам.
 * Возврат в меню кнопкой «Назад» считается как обычный раздел.
 */
export function loadRoot(): Promise<Screen> {
  return withTransaction(async (db) => {
    const repo = new SectionRepository(db);
    const root = await repo.root();
    return renderSection(root, await repo.children(root.id));
  });
}

/** Сообщение раздела; undefined — раздела нет (удалён в админке). */
export function loadSection(sectionId: number, viewer?: number): Promise<Screen | undefined> {
  return withTransaction(async (db) => {
    const repo = new SectionRepository(db);
    let section = await repo.get(sectionId);
    if (!section) return undefined;
    if (section.url) {
      // Старая кнопка раздела, который админ сделал ссылкой: его текст и
      // подразделы скрыты — показываем экран, где лежит его кнопка-ссылка.
      const parent = section.parentId !== null ? await repo.get(section.parentId) : undefined;
      section = parent ?? (await repo.root());
    }
    await countView(db, section.id, viewer);
    return renderSection(section, await repo.children(section.id));
  });
}

/** Пишет открытие раздела в статистику; администраторов не считает. */
async function countView(db: Queryable, sectionId: number, viewer?: number): Promise<void> {
  const settings = getSettings();
  if (!settings.statsEnabled || viewer === undefined || (await isAdmin(viewer, db))) return;
  const salt = settings.statsSalt || settings.maxBotToken;
  await new StatsRepository(db).record(sectionId, userHash(viewer, salt));
}

/** Картинка по токену MAX — повторная отправка уже загруженного фото. */
export function imageAttachment(token: string): AttachmentRequest {
  return { type: "image", payload: { token } };
}

/** Ошибка MAX 4xx — запрос отклонён, повтор того же не поможет. */
export function isRejected(error: unknown): error is MaxError {
  return error instanceof MaxError && error.status < 500;
}

/**
 * Отправляет экран; если MAX не принял картинку (4xx) — без неё.
 *
 * Картинку MAX проверяет при сохранении в админке, но токен может перестать
 * действовать и позже. Отказ из-за картинки не должен ломать меню:
 * пользователь получит текст и кнопки, в лог — предупреждение.
 */
export async function sendScreen(
  send: Send,
  text: string,
  attachments: Attachments,
): Promise<void> {
  try {
    await send(text, attachments);
  } catch (error) {
    const plain = attachments.filter((a) => a.type !== "image");
    if (!isRejected(error) || plain.length === attachments.length) throw error;
    console.warn("MAX не принял картинку раздела, отправляю без неё:", error.description);
    await send(text, plain);
  }
}

/** Новое сообщение в чат события; у callback без исходного сообщения — в личку автору. */
export function replyTo(ctx: Context): Send {
  const chatId = ctx.chatId;
  if (chatId)
    return (text, attachments) => ctx.api.sendMessageToChat(chatId, text, { attachments });
  const userId = ctx.user?.user_id;
  if (userId === undefined) throw new Error(`Некуда ответить на ${ctx.updateType}`);
  return (text, attachments) => ctx.api.sendMessageToUser(userId, text, { attachments });
}

/**
 * Заменяет сообщение с нажатой кнопкой новым экраном — чат не растёт.
 *
 * Правка и подтверждение нажатия — один вызов MAX, поэтому при неудаче
 * нажатие подтверждаем отдельно, иначе кнопка «зависнет» и пропадёт
 * уведомление. Новое сообщение — только когда править нечего или MAX отказал
 * (4xx). На 5xx правка могла пройти — второе сообщение засорило бы чат.
 * Сетевые ошибки не ловим: запасная отправка упала бы так же.
 */
export async function showInPlace(
  ctx: Context,
  screen: Screen,
  notification?: string,
): Promise<void> {
  if (ctx.message) {
    try {
      // Отказ мог быть из-за картинки — sendScreen повторит правку без неё.
      await sendScreen(
        (text, attachments) =>
          ctx.answerOnCallback({ notification, message: { text, attachments } }),
        screen.text,
        screen.attachments,
      );
      return;
    } catch (error) {
      if (!(error instanceof MaxError)) throw error;
      if (error.status >= 500) {
        console.warn("MAX не ответил на правку сообщения:", error.description);
        return;
      }
      console.info("MAX отказал в правке сообщения, отправляю новое:", error.description);
    }
  }
  try {
    await ctx.answerOnCallback({ notification });
  } catch (error) {
    if (!(error instanceof MaxError)) throw error;
    console.info("Не удалось подтвердить нажатие:", error.description);
  }
  await sendScreen(replyTo(ctx), screen.text, screen.attachments);
}

/** Нажатие кнопки раздела: экран меняется в том же сообщении. */
async function onCallback(ctx: Context): Promise<void> {
  const payload = ctx.callback?.payload ?? "";
  let screen: Screen | undefined;
  try {
    screen = await loadSection(SectionPayload.unpack(payload).sectionId, userIdOf(ctx));
  } catch (error) {
    if (!(error instanceof PayloadError)) throw error;
    // Payload из старой версии клавиатуры или подделанный.
    console.info(`Неизвестный payload callback: ${JSON.stringify(payload)}`);
  }
  if (screen) {
    await showInPlace(ctx, screen);
    return;
  }
  // Раздел (или вся ветка вместе с ним) удалён в админке, а кнопка — в том
  // числе «Назад» — осталась в старом сообщении. Не оставляем пользователя в
  // тупике: сразу даём главное меню.
  await showInPlace(ctx, await loadRoot(), STALE_TEXT);
}

/** Главное меню в ответ на событие. */
export async function sendRoot(ctx: Context): Promise<void> {
  const screen = await loadRoot();
  await sendScreen(replyTo(ctx), screen.text, screen.attachments);
}

/** На произвольный текст в личке — главное меню. */
async function onFreeText(ctx: Context): Promise<void> {
  // В группах на каждое сообщение не отвечаем: бот превратился бы в спамера.
  if (!isDialog(ctx)) return;
  await sendRoot(ctx);
}
