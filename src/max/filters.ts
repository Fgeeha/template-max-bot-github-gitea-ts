/** Фильтры для message_created: команды. */
import type { MessageCreated } from "./types.js";

export type Filter<T> = (event: T) => boolean;

export function commandStart(): Filter<MessageCreated> {
  return command("start");
}

export function command(name: string): Filter<MessageCreated> {
  const bare = `/${name}`;
  return (event) => {
    const text = event.message.text?.trim() ?? "";
    return text === bare || text.startsWith(`${bare} `);
  };
}
