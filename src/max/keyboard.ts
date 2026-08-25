/** Сборка инлайн-клавиатур. */
import type { Attachment } from "./types.js";

export interface CallbackButtonSpec {
  type: "callback";
  text: string;
  payload: string;
}

export interface LinkButtonSpec {
  type: "link";
  text: string;
  url: string;
}

export type ButtonSpec = CallbackButtonSpec | LinkButtonSpec;

export function callbackButton(text: string, payload: string): CallbackButtonSpec {
  return { type: "callback", text, payload };
}

export function linkButton(text: string, url: string): LinkButtonSpec {
  return { type: "link", text, url };
}

export class InlineKeyboardBuilder {
  private readonly rows: ButtonSpec[][] = [];

  row(...buttons: ButtonSpec[]): this {
    this.rows.push(buttons);
    return this;
  }

  asMarkup(): Attachment {
    return { type: "inline_keyboard", payload: { buttons: this.rows } };
  }
}
