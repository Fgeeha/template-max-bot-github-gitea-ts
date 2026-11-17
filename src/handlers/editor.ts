/**
 * Админка разделов: /admin в личке с ботом.
 *
 * Экран раздела показывает его текст и подразделы; кнопки — добавить
 * подраздел, переименовать, сменить текст, картинку, задать ссылку, сдвинуть,
 * удалить, посмотреть глазами пользователя. Название и текст администратор
 * присылает следующим сообщением — бот ждёт ввода, пока не нажата любая
 * кнопка админки.
 */
import type { Context, NextFn } from "@maxhub/max-bot-api";
import type { Section } from "../db/models.js";
import { withTransaction } from "../db/pool.js";
import { AuditRepository } from "../db/repositories/audit.js";
import { SectionRepository } from "../db/repositories/sections.js";
import { AdminAction, AdminPayload, PayloadError } from "../keyboards/callbacks.js";
import {
  cancelKeyboard,
  confirmDeleteKeyboard,
  linkKeyboard,
  MAX_CHILDREN,
} from "../keyboards/menus.js";
import { adminOnly, isAdmin, isDialog, userIdOf } from "./admin.js";
import type { Dispatcher } from "./index.js";
import {
  attachmentsOf,
  CLEAR,
  charSlice,
  imageTokenOf,
  parseLink,
  TITLE_MAX_LEN,
  validateText,
  validateTitle,
} from "./inputs.js";
import { imageAttachment, isRejected, renderSection, replyTo, sendScreen } from "./menu.js";
import { waiting } from "./pending.js";
import {
  type AdminScreen,
  auditText,
  buildScreen,
  name,
  SCREEN_TEXT_PREVIEW,
  showAdminScreen,
} from "./screens.js";
import * as tools from "./tools.js";

/** Ввод, который приходит вложением, а не текстом. */
const ATTACHMENT_INPUT = new Set([AdminAction.Image, AdminAction.Import]);

export function register(bot: Dispatcher): void {
  bot.command("admin", adminOnly(onAdminCommand));
  bot.action(/^a:/, onAdminCallback);
  bot.on("message_created", pendingInput);
}

/**
 * Сообщение в личке — ожидаемый ввод админки (команды не перехватываем).
 *
 * Сообщения из групп не берём: иначе реплика админа в общем чате стала бы
 * текстом раздела, а экран админки ушёл бы всем участникам.
 */
async function isPendingInput(ctx: Context): Promise<boolean> {
  const userId = userIdOf(ctx);
  const pending = userId !== undefined ? waiting.get(userId) : undefined;
  if (userId === undefined || !pending || !isDialog(ctx)) return false;
  if (!(await isAdmin(userId))) {
    // Доступ отозвали, пока бот ждал ввода: забываем ожидание, иначе все
    // сообщения бывшего админа молча уходили бы в этот хендлер.
    waiting.delete(userId);
    return false;
  }
  // Картинка приходит без текста — для неё вводом считается любое вложение:
  // фото сохранится, а на файл или стикер бот объяснит, что нужна картинка,
  // вместо того чтобы молча показать главное меню.
  if (ATTACHMENT_INPUT.has(pending[0]) && attachmentsOf(ctx.message).length > 0) return true;
  const text = ctx.message?.body.text;
  return !!text && !text.startsWith("/");
}

async function pendingInput(ctx: Context, next: NextFn): Promise<void> {
  if (await isPendingInput(ctx)) {
    await onAdminInput(ctx);
    return;
  }
  await next();
}

async function onAdminCommand(ctx: Context): Promise<void> {
  // В группе экран админки увидели бы все участники.
  if (!isDialog(ctx)) return;
  const userId = userIdOf(ctx);
  if (userId !== undefined) waiting.delete(userId);
  const screen = await withTransaction(async (db) => {
    const repo = new SectionRepository(db);
    return buildScreen(repo, await repo.root());
  });
  await ctx.reply(screen.text, { attachments: [screen.keyboard] });
}

async function onAdminCallback(ctx: Context): Promise<void> {
  const userId = userIdOf(ctx);
  if (userId === undefined || !(await isAdmin(userId))) {
    await ctx.answerOnCallback({ notification: "Недоступно" });
    return;
  }
  let payload: AdminPayload;
  try {
    payload = AdminPayload.unpack(ctx.callback?.payload ?? "");
  } catch (error) {
    if (!(error instanceof PayloadError)) throw error;
    await ctx.answerOnCallback({ notification: "Кнопка устарела, откройте /admin заново" });
    return;
  }

  // Любая кнопка админки отменяет ожидание ввода.
  waiting.delete(userId);

  if (tools.TOOL_ACTIONS.has(payload.action)) {
    await tools.dispatch(ctx, payload.action, payload.target, userId);
    return;
  }
  await dispatch(ctx, payload.action, payload.target, userId);
}

/** Действие кнопки админки над разделом. */
async function dispatch(
  ctx: Context,
  action: AdminAction,
  target: number,
  userId: number,
): Promise<void> {
  // Ответ MAX отправляем после commit: иначе админ увидел бы правку, которая
  // ещё может откатиться.
  const reply = await withTransaction(async (db) => {
    const repo = new SectionRepository(db);
    const audit = new AuditRepository(db);
    let section = action === AdminAction.Home ? await repo.root() : await repo.get(target);
    if (!section) return notify("Раздел уже удалён, откройте /admin заново");

    switch (action) {
      case AdminAction.Add:
        if ((await repo.children(section.id)).length >= MAX_CHILDREN) {
          return notify(`Не больше ${MAX_CHILDREN} подразделов`);
        }
        return ask(
          userId,
          action,
          section,
          `Пришлите название нового подраздела в «${section.title}» ` +
            `(это подпись кнопки, до ${TITLE_MAX_LEN} символов).`,
        );
      case AdminAction.Title:
        return ask(
          userId,
          action,
          section,
          `Сейчас: ${section.title}\n\nПришлите новое название (до ${TITLE_MAX_LEN} символов).`,
        );
      case AdminAction.Text: {
        const current = charSlice(section.text.trim() || "— не задан —", SCREEN_TEXT_PREVIEW);
        return ask(
          userId,
          action,
          section,
          `Сейчас:\n${current}\n\n` +
            "Пришлите новый текст одним сообщением. Эмодзи и переносы строк сохраняются.",
        );
      }
      case AdminAction.Image:
        return ask(
          userId,
          action,
          section,
          `Картинка сейчас: ${section.imageToken ? "есть" : "нет"}.\n\n` +
            "Пришлите одну картинку как обычное фото — она будет над текстом раздела " +
            `«${section.title}». Из альбома возьму первую, подпись к фото не ` +
            `сохраняется. Чтобы убрать картинку, пришлите «${CLEAR}».`,
        );
      case AdminAction.Link:
        if (section.parentId === null) return notify("У главного меню ссылки нет");
        return ask(
          userId,
          action,
          section,
          `Сейчас: ${section.url ?? "— не задана —"}\n\n` +
            `Пришлите ссылку (https://…) — кнопка «${section.title}» будет открывать её ` +
            `вместо текста.\nЧтобы убрать ссылку, пришлите «${CLEAR}».`,
        );
      case AdminAction.Delete: {
        if (section.parentId === null) return notify("Главное меню удалить нельзя");
        const nested = await repo.countDescendants(section.id);
        const warning = nested ? `\nВместе с ним удалятся вложенные разделы: ${nested}.` : "";
        return {
          screen: {
            text: `🗑 Удалить раздел «${section.title}»?${warning}\n\nОтменить удаление нельзя.`,
            keyboard: confirmDeleteKeyboard(section),
          },
        };
      }
      case AdminAction.Preview: {
        if (section.url) {
          // Экрана у раздела-ссылки нет — показываем саму кнопку, её можно нажать.
          return {
            preview: {
              text: `У пользователя кнопка «${section.title}» сразу открывает ссылку:`,
              attachments: [linkKeyboard(section)],
            },
          };
        }
        return { preview: renderSection(section, await repo.children(section.id)) };
      }
    }

    let notification: string | undefined;
    if (action === AdminAction.DeleteConfirm) {
      const parent = section.parentId !== null ? await repo.get(section.parentId) : undefined;
      if (!parent) return notify("Главное меню удалить нельзя");
      const nested = await repo.countDescendants(section.id);
      await repo.delete(section.id);
      console.info(`admin ${userId} удалил раздел ${section.id} «${section.title}»`);
      const extra = nested ? ` вместе с вложенными (${nested})` : "";
      await audit.log(userId, `удалил раздел ${name(section)}${extra}`);
      section = parent;
      notification = "Раздел удалён";
    } else if (action === AdminAction.Up || action === AdminAction.Down) {
      const moved = await repo.move(section, action === AdminAction.Up ? -1 : 1);
      notification = moved ? "Перемещено" : "Дальше двигать некуда";
      if (moved) {
        const where = action === AdminAction.Up ? "выше" : "ниже";
        await audit.log(userId, `сдвинул ${name(section)} ${where}`);
      }
    }
    // Open, Home и всё, что после действия возвращается на экран раздела.
    return { screen: await buildScreen(repo, section), notification };
  });

  if (reply.preview) {
    await sendScreen(replyTo(ctx), reply.preview.text, reply.preview.attachments);
    await ctx.answerOnCallback({ notification: "Так раздел увидит пользователь — сообщение ниже" });
  } else if (reply.screen) {
    await showAdminScreen(ctx, reply.screen, reply.notification);
  } else {
    await ctx.answerOnCallback({ notification: reply.notification });
  }
}

interface Reply {
  screen?: AdminScreen;
  preview?: { text: string; attachments: Parameters<typeof sendScreen>[2] };
  notification?: string;
}

function notify(notification: string): Reply {
  return { notification };
}

/** Переводит админа в ожидание ввода и показывает подсказку. */
function ask(userId: number, action: AdminAction, section: Section, prompt: string): Reply {
  waiting.set(userId, [action, section.id]);
  return { screen: { text: prompt, keyboard: cancelKeyboard(section.id) } };
}

/**
 * Присылает картинку админу: так MAX проверяет токен до сохранения. Без этой
 * проверки отказ MAX всплыл бы только у пользователей, где меню молча
 * показывается без картинки.
 */
async function checkImage(ctx: Context, token: string): Promise<string | undefined> {
  try {
    await ctx.reply("🖼 Так картинка будет выглядеть:", { attachments: [imageAttachment(token)] });
  } catch (error) {
    if (!isRejected(error)) throw error;
    console.warn("MAX не принял картинку из админки:", error.description);
    return "MAX не принял эту картинку — пришлите другую.";
  }
  return undefined;
}

/** Проверяет ввод; возвращает ошибку для админа или новое значение поля. */
async function validateInput(
  ctx: Context,
  action: AdminAction,
  value: string,
): Promise<{ error?: string; value: string | null }> {
  if (action === AdminAction.Image) {
    const image = imageTokenOf(ctx.message);
    if (image) return { error: await checkImage(ctx, image), value: image };
    if (value === CLEAR) return { value: null };
    return {
      error: "Нужна картинка — пришлите её как фото, не файлом и не стикером.",
      value: null,
    };
  }
  if (action === AdminAction.Text) return { error: validateText(value), value };
  if (action === AdminAction.Link) {
    if (value === CLEAR) return { value: null };
    const link = parseLink(value);
    return { error: link.error, value: link.value ?? null };
  }
  return { error: validateTitle(value), value };
}

/** Название, текст, ссылка или картинка, присланные после кнопки админки. */
async function onAdminInput(ctx: Context): Promise<void> {
  const userId = userIdOf(ctx);
  const pending = userId !== undefined ? waiting.get(userId) : undefined;
  if (userId === undefined || !pending) return;
  const [action, sectionId] = pending;
  if (tools.INPUT_ACTIONS.has(action)) {
    await tools.handleInput(ctx, action, userId);
    return;
  }
  // Раздел мог удалить другой админ — проверяем до предпросмотра картинки,
  // иначе админ получил бы превью, а следом «раздел удалён».
  if (!(await withTransaction((db) => new SectionRepository(db).get(sectionId)))) {
    waiting.delete(userId);
    await ctx.reply("Раздел уже удалён. Откройте /admin заново.");
    return;
  }
  const value = (ctx.message?.body.text ?? "").trim();
  const input = await validateInput(ctx, action, value);

  const result = await withTransaction(async (db) => {
    const repo = new SectionRepository(db);
    let section = await repo.get(sectionId);
    if (!section) {
      waiting.delete(userId);
      return { text: "Раздел уже удалён. Откройте /admin заново." };
    }
    let error = input.error;
    if (!error && action === AdminAction.Add) {
      // Лимит проверяется и при нажатии «➕», но между нажатием и вводом
      // подраздел мог добавить другой админ.
      if ((await repo.children(section.id)).length >= MAX_CHILDREN) {
        error = `В разделе уже ${MAX_CHILDREN} подразделов — больше MAX не покажет.`;
      }
    }
    if (error) {
      // Ожидание не снимаем: админ просто присылает исправленный вариант.
      return { text: `⚠️ ${error}`, keyboard: cancelKeyboard(section.id) };
    }
    waiting.delete(userId);

    const oldTitle = section.title;
    let done: string;
    if (action === AdminAction.Add) {
      section = await repo.add(section.id, value);
      done =
        "Подраздел добавлен. Задайте ему текст кнопкой «📝 Текст» " +
        "или сделайте кнопкой-ссылкой через «🔗 Ссылка».";
    } else if (action === AdminAction.Title) {
      section.title = value;
      done = "Название сохранено.";
    } else if (action === AdminAction.Link) {
      section.url = input.value;
      done = section.url ? "Ссылка сохранена." : "Ссылка убрана.";
    } else if (action === AdminAction.Image) {
      section.imageToken = input.value;
      done = section.imageToken ? "Картинка сохранена." : "Картинка убрана.";
    } else {
      section.text = value;
      done = "Текст сохранён.";
      if (imageTokenOf(ctx.message)) {
        done += " Картинку из сообщения я не сохранил — для неё есть «🖼 Картинка».";
      }
    }
    if (action !== AdminAction.Add) await repo.save(section);
    console.info(`admin ${userId}: ${action} раздела ${section.id}`);
    await new AuditRepository(db).log(userId, auditText(action, section, oldTitle));
    const screen = await buildScreen(repo, section);
    return { text: `✅ ${done}\n\n${screen.text}`, keyboard: screen.keyboard };
  });

  await ctx.reply(result.text, result.keyboard ? { attachments: [result.keyboard] } : undefined);
}
