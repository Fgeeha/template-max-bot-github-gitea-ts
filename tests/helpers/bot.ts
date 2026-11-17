/**
 * Сценарные тесты: апдейты MAX прогоняются через настоящую цепочку хендлеров
 * (registerHandlers — тот же порядок, что в проде), а вызовы API пишет FakeApi.
 * Нажатие кнопки — press, сообщение — send.
 */
import { readFileSync } from "node:fs";
import { type Api, Composer, Context, FileAttachment, MaxError } from "@maxhub/max-bot-api";
import type {
  AnswerOnCallbackExtra,
  Attachment,
  AttachmentRequest,
  ChatType,
  SendMessageExtra,
  Update,
} from "@maxhub/max-bot-api/types";
import { registerHandlers } from "../../src/handlers/index.js";
import { waiting } from "../../src/handlers/pending.js";

export const ADMIN = 1;
export const STRANGER = 2;
const CHAT_ID = 100;

export interface Shown {
  text: string;
  attachments: AttachmentRequest[];
  /** edit — правка сообщения с кнопкой, chat — новое в чат, user — в личку по user_id. */
  via: "edit" | "chat" | "user";
}

export class FakeApi {
  /** Всё, что бот показал, по порядку: правки и новые сообщения. */
  readonly shown: Shown[] = [];
  readonly answers: AnswerOnCallbackExtra[] = [];
  readonly uploads: string[] = [];
  /** Падает правка сообщения (answerOnCallback с message). */
  failEdit?: MaxError;
  /** Сколько раз подряд ответить attachment.not.ready на сообщение с файлом. */
  fileNotReady = 0;
  /** MAX отклоняет любое сообщение с картинкой. */
  rejectImages = false;

  async sendMessageToChat(_chatId: number, text: string, extra?: SendMessageExtra) {
    this.check(extra?.attachments);
    this.shown.push({ text, attachments: extra?.attachments ?? [], via: "chat" });
  }

  async sendMessageToUser(_userId: number, text: string, extra?: SendMessageExtra) {
    this.check(extra?.attachments);
    this.shown.push({ text, attachments: extra?.attachments ?? [], via: "user" });
  }

  async answerOnCallback(_callbackId: string, extra: AnswerOnCallbackExtra) {
    if (extra.message) {
      if (this.failEdit) throw this.failEdit;
      this.check(extra.message.attachments);
      this.shown.push({
        text: extra.message.text ?? "",
        attachments: extra.message.attachments ?? [],
        via: "edit",
      });
    }
    this.answers.push(extra);
  }

  async uploadFile({ source }: { source: string }) {
    this.uploads.push(readFileSync(source, "utf8"));
    return new FileAttachment({ token: "file-token" });
  }

  private check(attachments: AttachmentRequest[] | null | undefined): void {
    if (this.fileNotReady > 0 && attachments?.some((a) => a.type === "file")) {
      this.fileNotReady -= 1;
      throw new MaxError(400, { code: "attachment.not.ready", message: "not ready" });
    }
    if (this.rejectImages && attachments?.some((a) => a.type === "image")) {
      throw new MaxError(400, { code: "attachment.invalid", message: "bad image" });
    }
  }

  /** Экран, который пользователь увидел последним. */
  get last(): Shown {
    const shown = this.shown.at(-1);
    if (!shown) throw new Error("бот ничего не показал");
    return shown;
  }

  /** Последнее всплывающее уведомление. */
  get notification(): string | undefined {
    return this.answers.at(-1)?.notification ?? undefined;
  }
}

const bot = new Composer<Context>();
registerHandlers(bot);

async function run(update: Update, api: FakeApi): Promise<FakeApi> {
  await bot.middleware()(new Context(update, api as unknown as Api), async () => {});
  return api;
}

function message(userId: number, text: string, attachments: Attachment[], chatType: ChatType) {
  return {
    sender: { user_id: userId, name: "Тест", is_bot: false, last_activity_time: 0 },
    recipient: { chat_id: CHAT_ID, chat_type: chatType },
    timestamp: 0,
    body: { mid: "mid", seq: 1, text, attachments },
  };
}

export interface SendOptions {
  image?: string;
  file?: { url: string; filename: string };
  chatType?: ChatType;
  api?: FakeApi;
}

/** Сообщение пользователя боту. */
export function send(userId: number, text: string, options: SendOptions = {}): Promise<FakeApi> {
  const attachments: Attachment[] = [];
  if (options.image) {
    attachments.push({ type: "image", payload: { url: "", token: options.image, photo_id: 1 } });
  }
  if (options.file) {
    attachments.push({
      type: "file",
      payload: { url: options.file.url, token: "t" },
      filename: options.file.filename,
      size: 1,
    });
  }
  const update = {
    update_type: "message_created",
    timestamp: 0,
    message: message(userId, text, attachments, options.chatType ?? "dialog"),
  } as unknown as Update;
  return run(update, options.api ?? new FakeApi());
}

/** Нажатие кнопки. withoutMessage — исходное сообщение MAX не прислал. */
export function press(
  userId: number,
  payload: string,
  api = new FakeApi(),
  withoutMessage = false,
): Promise<FakeApi> {
  const update = {
    update_type: "message_callback",
    timestamp: 0,
    callback: { callback_id: "cb", payload, timestamp: 0, user: { user_id: userId } },
    message: withoutMessage ? undefined : message(ADMIN, "старый экран", [], "dialog"),
  } as unknown as Update;
  return run(update, api);
}

/** Подпись кнопки → payload (у кнопки-ссылки — url) по всем клавиатурам экрана. */
export function buttons(attachments: AttachmentRequest[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const attachment of attachments) {
    if (attachment.type !== "inline_keyboard") continue;
    for (const row of attachment.payload.buttons) {
      for (const button of row) {
        result[button.text] =
          "payload" in button ? button.payload : "url" in button ? button.url : "";
      }
    }
  }
  return result;
}

/** Payload кнопки экрана по подписи; падает, если кнопки нет. */
export function tap(attachments: AttachmentRequest[], label: string): string {
  const payload = buttons(attachments)[label];
  if (payload === undefined) {
    throw new Error(`нет кнопки «${label}»: ${Object.keys(buttons(attachments)).join(", ")}`);
  }
  return payload;
}

export function resetPending(): void {
  waiting.clear();
}
