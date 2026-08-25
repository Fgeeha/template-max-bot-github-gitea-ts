/**
 * Типы апдейтов и событий MAX Bot API.
 *
 * Официального Node/TS SDK для MAX не существует — это тонкий вендоренный
 * клиент, повторяющий поверхность обёрнутой в Python-шаблоне библиотеки
 * maxapi (те же имена методов и событий). Перед продом сверьте пути
 * эндпоинтов и форму JSON с актуальной документацией: https://dev.max.ru/.
 */
import type { Bot } from "./bot.js";

export enum UpdateType {
  MessageCreated = "message_created",
  MessageCallback = "message_callback",
  BotStarted = "bot_started",
}

export enum ChatType {
  Dialog = "dialog",
  Chat = "chat",
}

export interface Attachment {
  type: string;
  payload: Record<string, unknown>;
}

export interface RecipientInfo {
  chatId: number;
  chatType: ChatType;
}

export interface SenderInfo {
  userId: number;
  username?: string;
}

/** Идентификаторы события — chatId/userId, если событие их несёт. */
export interface EventIds {
  chatId?: number;
  userId?: number;
}

export interface HasIds {
  /** undefined — у события нет идентификаторов (аналог NotImplementedError в Python-версии). */
  getIds(): EventIds | undefined;
}

export class Message {
  constructor(
    private readonly bot: Bot,
    readonly recipient: RecipientInfo,
    readonly sender: SenderInfo | undefined,
    readonly text: string | undefined,
    readonly messageId: string | undefined,
  ) {}

  async answer(options: { text: string; attachments?: Attachment[] }): Promise<void> {
    await this.bot.sendMessage({
      chatId: this.recipient.chatId,
      text: options.text,
      attachments: options.attachments,
    });
  }
}

export class MessageCreated implements HasIds {
  constructor(
    readonly bot: Bot,
    readonly message: Message,
  ) {}

  getIds(): EventIds {
    return { chatId: this.message.recipient.chatId, userId: this.message.sender?.userId };
  }
}

export class MessageCallback implements HasIds {
  constructor(
    readonly bot: Bot,
    readonly message: Message,
    readonly callback: { callbackId: string; payload: string | undefined; userId: number },
  ) {}

  getIds(): EventIds {
    return { chatId: this.message.recipient.chatId, userId: this.callback.userId };
  }

  async answer(options: { notification?: string; text?: string }): Promise<void> {
    await this.bot.answerCallback(this.callback.callbackId, options);
  }
}

export class BotStarted implements HasIds {
  constructor(
    readonly bot: Bot,
    readonly chatId: number,
    readonly userId: number,
  ) {}

  getIds(): EventIds {
    return { chatId: this.chatId, userId: this.userId };
  }
}

export type UpdateEvent = MessageCreated | MessageCallback | BotStarted;

/** Сырой JSON апдейта, как его присылает платформа (webhook) или отдаёт /updates (polling). */
export interface RawUpdate {
  update_type: string;
  message?: {
    body?: { text?: string; mid?: string };
    recipient: { chat_id: number; chat_type: string };
    sender?: { user_id: number; username?: string };
  };
  callback?: {
    callback_id: string;
    payload?: string;
    user: { user_id: number; username?: string };
    message?: RawUpdate["message"];
  };
  chat_id?: number;
  user?: { user_id: number; username?: string };
}

function buildMessage(bot: Bot, raw: NonNullable<RawUpdate["message"]>): Message {
  return new Message(
    bot,
    {
      chatId: raw.recipient.chat_id,
      chatType: raw.recipient.chat_type === ChatType.Dialog ? ChatType.Dialog : ChatType.Chat,
    },
    raw.sender ? { userId: raw.sender.user_id, username: raw.sender.username } : undefined,
    raw.body?.text,
    raw.body?.mid,
  );
}

/** Разбирает сырой JSON апдейта в типизированное событие. undefined — апдейт неизвестного/неполного вида, игнорируется. */
export function parseUpdate(bot: Bot, raw: RawUpdate): UpdateEvent | undefined {
  switch (raw.update_type) {
    case UpdateType.MessageCreated:
      return raw.message ? new MessageCreated(bot, buildMessage(bot, raw.message)) : undefined;

    case UpdateType.MessageCallback: {
      const callback = raw.callback;
      if (!callback?.message) return undefined;
      return new MessageCallback(bot, buildMessage(bot, callback.message), {
        callbackId: callback.callback_id,
        payload: callback.payload,
        userId: callback.user.user_id,
      });
    }

    case UpdateType.BotStarted:
      return raw.chat_id !== undefined && raw.user
        ? new BotStarted(bot, raw.chat_id, raw.user.user_id)
        : undefined;

    default:
      return undefined;
  }
}
