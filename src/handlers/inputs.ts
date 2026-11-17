/**
 * Проверка того, что администратор присылает в админку.
 *
 * Лимиты — от MAX: подпись кнопки до 64 символов, сообщение до 4000, ссылка
 * link-кнопки до 2048. Ошибки — готовый текст для админа. Длина считается в
 * символах Unicode, а не в UTF-16 (String.length дал бы за эмодзи двойку).
 */
import type { Attachment, FileAttachment, Message } from "@maxhub/max-bot-api/types";
import type { TreeNode } from "../db/repositories/sections.js";
import { MAX_CHILDREN } from "../keyboards/menus.js";

export const TITLE_MAX_LEN = 64;
export const TEXT_MAX_LEN = 4000;
export const URL_MAX_LEN = 2048;
/** Ответ «убрать» на запрос ссылки или картинки. */
export const CLEAR = "-";

// Postgres не хранит NUL в text — без проверки файл импорта ронял бы транзакцию.
const NUL_ERROR = "Недопустимый символ (NUL) в тексте.";

/** Длина в символах Unicode. */
export function charLength(text: string): number {
  return [...text].length;
}

/** Первые limit символов Unicode — без разрыва суррогатной пары. */
export function charSlice(text: string, limit: number): string {
  return [...text].slice(0, limit).join("");
}

/** Текст ошибки или undefined, если название годится. */
export function validateTitle(title: string): string | undefined {
  if (!title) return "Название не может быть пустым.";
  if (title.includes("\u0000")) return NUL_ERROR;
  const length = charLength(title);
  if (length > TITLE_MAX_LEN) {
    return `Название длиннее ${TITLE_MAX_LEN} символов (${length}). Сократите.`;
  }
  return undefined;
}

/** Текст ошибки или undefined, если текст раздела укладывается в лимит MAX. */
export function validateText(text: string): string | undefined {
  if (text.includes("\u0000")) return NUL_ERROR;
  const length = charLength(text);
  if (length > TEXT_MAX_LEN)
    return `Текст длиннее ${TEXT_MAX_LEN} символов (${length}). Сократите.`;
  return undefined;
}

export type Parsed<T> = { value: T; error?: undefined } | { value?: undefined; error: string };

/**
 * Ссылка для link-кнопки: нормализованный адрес или ошибка.
 *
 * Проверка строгая: MAX отклонит сообщение целиком, если ему не понравится
 * одна link-кнопка, — и под ударом главное меню и /start у всех. Поэтому
 * только http(s), адрес сайта с точкой, без логина и управляющих символов.
 * Кириллический домен WHATWG URL сам переводит в punycode.
 */
export function parseLink(raw: string): Parsed<string> {
  const error = "Нужна ссылка вида https://example.ru — с http:// или https:// и без пробелов.";
  if (/[\s\p{C}]/u.test(raw)) return { error };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error };
  }
  const host = url.hostname.replace(/^\.+|\.+$/g, "");
  if (!["http:", "https:"].includes(url.protocol) || !host.includes(".")) return { error };
  if (url.username || url.password) return { error };
  const href = url.href;
  if (href.length > URL_MAX_LEN)
    return { error: `Ссылка длиннее ${URL_MAX_LEN} символов (${href.length}).` };
  return { value: href };
}

/** Числовой MAX user ID или ошибка. */
export function parseUserId(raw: string): Parsed<number> {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
    return { error: "Нужен числовой MAX user ID, например 123456789. Его покажет команда /id." };
  }
  return { value };
}

/** Вложения входящего сообщения. */
export function attachmentsOf(message: Message | null | undefined): Attachment[] {
  return message?.body.attachments ?? [];
}

/** Первое вложение-файл (не фото) или undefined. */
export function fileOf(message: Message | null | undefined): FileAttachment | undefined {
  return attachmentsOf(message).find((a): a is FileAttachment => a.type === "file" && !!a.payload);
}

/**
 * Токен первой картинки во входящем сообщении или undefined.
 *
 * MAX позволяет отправить то же вложение повторно по этому токену, поэтому
 * файл не скачивается и не хранится. Из альбома берётся первая картинка.
 */
export function imageTokenOf(message: Message | null | undefined): string | undefined {
  for (const attachment of attachmentsOf(message)) {
    if (attachment.type === "image") return attachment.payload?.token || undefined;
  }
  return undefined;
}

// Файл экспорта: {"format": EXPORT_FORMAT, "version": 1, "root": узел}, где
// узел — {"title", "text", "url", "image_token", "children": [узлы]}.
// Формат общий с Python-версией шаблона: файл переносится между ними.
export const EXPORT_FORMAT = "max-bot-sections";
export const EXPORT_VERSION = 1;
// Пределы импорта: защита от случайно присланного огромного или зацикленного файла.
export const IMPORT_MAX_BYTES = 1_000_000;
export const IMPORT_MAX_NODES = 1000;
export const IMPORT_MAX_DEPTH = 20;

class TreeError extends Error {}

/**
 * Корень дерева из файла экспорта или ошибка.
 *
 * Названия, тексты и ссылки проверяются теми же правилами, что и ввод в
 * админке: файл, собранный вручную, не должен положить меню у всех
 * пользователей. Токены картинок не проверяются (только тип) — если MAX их
 * не примет, раздел покажется без картинки (см. menu.ts sendScreen).
 */
export function parseTree(data: Uint8Array): Parsed<TreeNode> {
  if (data.byteLength > IMPORT_MAX_BYTES) {
    return { error: `Файл больше ${IMPORT_MAX_BYTES / 1000} КБ.` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    return { error: "Это не JSON. Пришлите файл, который бот выдал кнопкой «⬇️ Скачать»." };
  }
  if (!isObject(doc) || doc.format !== EXPORT_FORMAT || doc.version !== EXPORT_VERSION) {
    return { error: "Это не файл экспорта разделов этого бота (нет format/version)." };
  }
  const counter = { nodes: 0 };
  try {
    return { value: parseNode(doc.root, "Главное меню", 0, counter) };
  } catch (error) {
    if (error instanceof TreeError) return { error: error.message };
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNode(
  raw: unknown,
  where: string,
  depth: number,
  counter: { nodes: number },
): TreeNode {
  counter.nodes += 1;
  if (counter.nodes > IMPORT_MAX_NODES) throw new TreeError(`Разделов больше ${IMPORT_MAX_NODES}.`);
  if (depth > IMPORT_MAX_DEPTH)
    throw new TreeError(`Вложенность глубже ${IMPORT_MAX_DEPTH} уровней.`);
  if (!isObject(raw)) throw new TreeError(`${where}: раздел должен быть объектом.`);

  const { title, text, url, image_token: image } = raw;
  const children = raw.children ?? [];
  if (typeof title !== "string") throw new TreeError(`${where}: нет названия.`);
  const titleError = validateTitle(title.trim());
  if (titleError) throw new TreeError(`${where}: ${titleError}`);
  const here = `«${title.trim()}»`;
  if (typeof text !== "string") throw new TreeError(`${here}: текст должен быть строкой.`);
  const textError = validateText(text);
  if (textError) throw new TreeError(`${here}: ${textError}`);

  // У главного меню ссылки не бывает — её кнопку некуда поставить.
  let link: string | null = null;
  if (url !== null && url !== undefined && depth > 0) {
    const parsed = typeof url === "string" ? parseLink(url) : { error: "битая ссылка." };
    if (parsed.error !== undefined) throw new TreeError(`${here}: ${parsed.error}`);
    link = parsed.value;
  }
  if (image !== null && image !== undefined && typeof image !== "string") {
    throw new TreeError(`${here}: image_token должен быть строкой.`);
  }
  if (!Array.isArray(children) || children.length > MAX_CHILDREN) {
    throw new TreeError(`${here}: подразделов должно быть не больше ${MAX_CHILDREN}.`);
  }
  return {
    title: title.trim(),
    text,
    url: link,
    image_token: image || null,
    children: children.map((child) => parseNode(child, here, depth + 1, counter)),
  };
}
