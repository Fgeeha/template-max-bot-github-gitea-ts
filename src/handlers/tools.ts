/**
 * Инструменты главного экрана админки.
 *
 * 👥 администраторы (добавляет и отзывает только владелец из ADMIN_IDS),
 * 📊 статистика открытий разделов, 📦 выгрузка и загрузка дерева разделов
 * JSON-файлом, 📜 журнал изменений. Вызываются из handlers/editor.ts: там
 * общая проверка прав и разбор payload.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Context, MaxError } from "@maxhub/max-bot-api";
import { getSettings } from "../config.js";
import { type Queryable, withTransaction } from "../db/pool.js";
import { AuditRepository } from "../db/repositories/audit.js";
import { SectionRepository } from "../db/repositories/sections.js";
import { StaffRepository } from "../db/repositories/staff.js";
import { StatsRepository } from "../db/repositories/stats.js";
import { AdminAction } from "../keyboards/callbacks.js";
import {
  cancelKeyboard,
  confirmStaffDeleteKeyboard,
  homeKeyboard,
  STATS_PERIODS,
  staffKeyboard,
  statsKeyboard,
  transferKeyboard,
} from "../keyboards/menus.js";
import { isOwner } from "./admin.js";
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  fileOf,
  IMPORT_MAX_BYTES,
  parseTree,
  parseUserId,
} from "./inputs.js";
import { replyTo } from "./menu.js";
import { waiting } from "./pending.js";
import { type AdminScreen, buildScreen, showAdminScreen } from "./screens.js";

export const TOOL_ACTIONS: ReadonlySet<AdminAction> = new Set([
  AdminAction.Staff,
  AdminAction.StaffAdd,
  AdminAction.StaffDel,
  AdminAction.StaffDelConfirm,
  AdminAction.Stats,
  AdminAction.Transfer,
  AdminAction.Export,
  AdminAction.Import,
  AdminAction.Log,
]);
/** Действия, после которых бот ждёт следующее сообщение администратора. */
export const INPUT_ACTIONS: ReadonlySet<AdminAction> = new Set([
  AdminAction.StaffAdd,
  AdminAction.Import,
]);
const OWNER_ONLY: ReadonlySet<AdminAction> = new Set([
  AdminAction.StaffAdd,
  AdminAction.StaffDel,
  AdminAction.StaffDelConfirm,
]);

const LOG_LIMIT = 30;
const STATS_TOP = 20;

const pad = (n: number): string => String(n).padStart(2, "0");

/** Время для админа со смещением DISPLAY_UTC_OFFSET: «дд.мм чч:мм» или «дд.мм.гггг». */
export function localTime(moment: Date, withYear = false): string {
  const t = new Date(moment.getTime() + getSettings().displayUtcOffset * 3_600_000);
  const day = `${pad(t.getUTCDate())}.${pad(t.getUTCMonth() + 1)}`;
  if (withYear) return `${day}.${t.getUTCFullYear()}`;
  return `${day} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

/** Кнопка инструмента; права администратора уже проверены. */
export async function dispatch(
  ctx: Context,
  action: AdminAction,
  arg: number,
  userId: number,
): Promise<void> {
  if (OWNER_ONLY.has(action) && !isOwner(userId)) {
    await ctx.answerOnCallback({ notification: "Только для владельца (ADMIN_IDS)" });
    return;
  }

  if (action === AdminAction.StaffAdd) {
    waiting.set(userId, [action, 0]);
    await showAdminScreen(ctx, {
      text:
        "Пришлите числовой MAX user ID нового администратора.\n\n" +
        "Узнать его: пусть человек напишет боту /id.",
      keyboard: cancelKeyboard(0, AdminAction.Staff),
    });
    return;
  }

  if (action === AdminAction.StaffDel) {
    await showAdminScreen(ctx, {
      text: `🚫 Отозвать доступ к админке у ${arg}?`,
      keyboard: confirmStaffDeleteKeyboard(arg),
    });
    return;
  }

  if (action === AdminAction.Export) {
    await sendExport(ctx, "⬇️ Разделы бота. Загрузить обратно — «📦 Файл → ⬆️ Загрузить».");
    await ctx.answerOnCallback({ notification: "Файл — сообщением ниже" });
    return;
  }

  if (action === AdminAction.Import) {
    // Копия текущего дерева — до замены: откатиться можно, загрузив её.
    await sendExport(ctx, "💾 Резервная копия текущих разделов — на случай отката.");
    waiting.set(userId, [action, 0]);
    await showAdminScreen(ctx, {
      text:
        "⬆️ Пришлите JSON-файл экспорта (файлом, не текстом).\n\n" +
        "⚠️ Все разделы заменятся разделами из файла. Старые кнопки в " +
        "чатах пользователей перестанут вести в разделы, статистика " +
        "по ним уйдёт в «удалённые разделы». Копия текущих — выше.",
      keyboard: cancelKeyboard(0, AdminAction.Transfer),
    });
    return;
  }

  let notification: string | undefined;
  const screen = await withTransaction(async (db) => {
    let current = action;
    if (action === AdminAction.StaffDelConfirm) {
      const removed = await new StaffRepository(db).remove(arg);
      if (removed) {
        await new AuditRepository(db).log(userId, `отозвал администратора ${arg}`);
        console.info(`owner ${userId} отозвал администратора ${arg}`);
      }
      notification = removed ? "Доступ отозван" : "Его уже нет в списке";
      current = AdminAction.Staff;
    }
    return toolScreen(db, current, arg, userId);
  });
  await showAdminScreen(ctx, screen, notification);
}

/** Текст и клавиатура экрана инструмента. */
async function toolScreen(
  db: Queryable,
  action: AdminAction,
  arg: number,
  userId: number,
): Promise<AdminScreen> {
  if (action === AdminAction.Staff) return staffScreen(db, userId);
  if (action === AdminAction.Stats) return statsScreen(db, arg);
  if (action === AdminAction.Log) {
    const entries = await new AuditRepository(db).recent(LOG_LIMIT);
    const lines = [`📜 Последние изменения (до ${LOG_LIMIT})`, ""];
    for (const e of entries) lines.push(`${localTime(e.createdAt)} · ${e.userId} · ${e.details}`);
    if (entries.length === 0) lines.push("Изменений пока не было.");
    return { text: lines.join("\n"), keyboard: homeKeyboard() };
  }
  return {
    text:
      "📦 Разделы файлом\n\n" +
      "⬇️ Скачать — всё дерево разделов (тексты, ссылки, картинки) JSON-файлом: " +
      "резервная копия или перенос в другого бота на этом шаблоне.\n" +
      "⬆️ Загрузить — заменить все разделы разделами из такого файла.\n\n" +
      "Картинки в файле — токены MAX: в другом боте они могут не открыться, " +
      "тогда раздел покажется без картинки.",
    keyboard: transferKeyboard(),
  };
}

async function staffScreen(db: Queryable, userId: number): Promise<AdminScreen> {
  const staff = await new StaffRepository(db).all();
  const owners = [...getSettings().adminIdsSet].sort((a, b) => a - b).join(", ") || "—";
  const lines = ["👥 Администраторы", "", `Владельцы (ADMIN_IDS в .env): ${owners}`, ""];
  if (staff.length > 0) {
    lines.push("Добавлены через админку:");
    for (const s of staff) lines.push(`• ${s.userId} — с ${localTime(s.createdAt, true)}`);
  } else {
    lines.push("Через админку никого не добавляли.");
  }
  const canEdit = isOwner(userId);
  if (!canEdit) lines.push("", "Добавлять и отзывать администраторов может только владелец.");
  return {
    text: lines.join("\n"),
    keyboard: staffKeyboard(
      staff.map((s) => s.userId),
      canEdit,
    ),
  };
}

async function statsScreen(db: Queryable, requested: number): Promise<AdminScreen> {
  const days = (STATS_PERIODS as readonly number[]).includes(requested)
    ? requested
    : STATS_PERIODS[1];
  const report = await new StatsRepository(db).report(days, STATS_TOP);
  const lines = [`📊 Статистика за ${days} дн.`, ""];
  if (!getSettings().statsEnabled) lines.push("⚠️ Сбор выключен (STATS_ENABLED=false в .env).", "");
  lines.push(`Открытий разделов: ${report.opens}`, `Пользователей: ${report.users}`, "");
  if (report.top.length > 0) {
    lines.push("Популярные разделы (открытий / пользователей):");
    for (const [index, item] of report.top.entries()) {
      lines.push(
        `${index + 1}. ${item.title ?? "удалённые разделы"} — ${item.opens} / ${item.users}`,
      );
    }
  }
  lines.push("", "Нажатия администраторов не учитываются.");
  return { text: lines.join("\n"), keyboard: statsKeyboard() };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Отправляет дерево разделов файлом.
 *
 * Через временный файл, а не Buffer: у буфера клиент MAX подставляет имя
 * случайным UUID без расширения, у файла с диска берёт имя как есть.
 */
async function sendExport(ctx: Context, caption: string): Promise<void> {
  const tree = await withTransaction((db) => new SectionRepository(db).exportTree());
  const now = new Date();
  const doc = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exported_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    root: tree,
  };
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const dir = await mkdtemp(path.join(tmpdir(), "sections-"));
  try {
    const file = path.join(dir, `sections-${stamp}.json`);
    await writeFile(file, JSON.stringify(doc, null, 2), "utf8");
    const attachment = (await ctx.api.uploadFile({ source: file })).toJson();
    const send = replyTo(ctx);
    // Только что загруженный файл MAX обрабатывает не мгновенно и отвечает
    // attachment.not.ready — повторяем с паузой.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await send(caption, [attachment]);
        return;
      } catch (error) {
        const notReady = error instanceof MaxError && error.code === "attachment.not.ready";
        if (!notReady || attempt >= 5) throw error;
        await sleep(attempt * 1000);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Скачивает присланный файл; больше IMPORT_MAX_BYTES не читает.
 *
 * ponytail: адрес не проверяется на внутренние сети — его выдаёт MAX, а файл
 * присылает только администратор. Для недоверенных отправителей нужна
 * проверка, что хост не резолвится во внутренние сети.
 */
export async function download(url: string): Promise<Uint8Array> {
  if (!url.startsWith("https://")) throw new Error("MAX прислал файл не по https");
  // Через общий globalThis.fetch: скачивание идёт под тем же лимитом RPS и
  // ретраями на 429, что и API, — для одного файла от админа это безвредно.
  // redirect: "error" — иначе редирект увёл бы мимо проверки https выше.
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    chunks.push(chunk);
    size += chunk.byteLength;
    // +1 байт сверх предела достаточно, чтобы parseTree отказал по размеру.
    if (size > IMPORT_MAX_BYTES) break;
  }
  return Buffer.concat(chunks);
}

/** Сообщение администратора в ответ на StaffAdd или Import. */
export async function handleInput(
  ctx: Context,
  action: AdminAction,
  userId: number,
): Promise<void> {
  if (action === AdminAction.StaffAdd) {
    await inputStaff(ctx, userId);
  } else {
    await inputImport(ctx, userId);
  }
}

async function inputStaff(ctx: Context, userId: number): Promise<void> {
  const parsed = parseUserId((ctx.message?.body.text ?? "").trim());
  let error = parsed.error;
  if (parsed.value !== undefined && isOwner(parsed.value)) {
    error = "Это владелец из ADMIN_IDS — у него и так есть доступ.";
  }
  if (error || parsed.value === undefined) {
    await ctx.reply(`⚠️ ${error}`, { attachments: [cancelKeyboard(0, AdminAction.Staff)] });
    return;
  }
  const newId = parsed.value;
  waiting.delete(userId);
  const { added, screen } = await withTransaction(async (db) => {
    const added = await new StaffRepository(db).add(newId, userId);
    if (added) {
      await new AuditRepository(db).log(userId, `добавил администратора ${newId}`);
      console.info(`owner ${userId} добавил администратора ${newId}`);
    }
    return { added, screen: await staffScreen(db, userId) };
  });
  const done = added ? "Администратор добавлен." : "Он уже администратор.";
  await ctx.reply(`✅ ${done}\n\n${screen.text}`, { attachments: [screen.keyboard] });
}

async function inputImport(ctx: Context, userId: number): Promise<void> {
  const retry = { attachments: [cancelKeyboard(0, AdminAction.Transfer)] };
  const attachment = fileOf(ctx.message);
  if (!attachment) {
    await ctx.reply("⚠️ Нужен JSON-файл — пришлите его вложением-файлом.", retry);
    return;
  }
  let data: Uint8Array;
  try {
    data = await download(attachment.payload.url);
  } catch (error) {
    // В лог — только тип ошибки: в URL вложения бывает токен доступа.
    console.warn(`Не удалось скачать файл импорта: ${(error as Error).name}`);
    await ctx.reply("⚠️ Не удалось скачать файл. Пришлите его ещё раз.", retry);
    return;
  }
  const tree = parseTree(data);
  if (tree.error !== undefined) {
    await ctx.reply(`⚠️ ${tree.error}`, retry);
    return;
  }
  waiting.delete(userId);

  const fileName = attachment.filename || "без имени";
  const screen = await withTransaction(async (db) => {
    const repo = new SectionRepository(db);
    const root = await repo.replaceTree(tree.value);
    await new AuditRepository(db).log(userId, `загрузил разделы из файла «${fileName}»`);
    console.info(`admin ${userId} заменил дерево разделов из файла`);
    return buildScreen(repo, root);
  });
  await ctx.reply(`✅ Разделы загружены.\n\n${screen.text}`, { attachments: [screen.keyboard] });
}
