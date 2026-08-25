/**
 * Типизированные payload'ы callback-кнопок.
 *
 * MAX передаёт payload кнопки строкой ограниченной длины, поэтому кодируем
 * его компактно: `<префикс>:<значение>`. Разбор вынесен сюда, чтобы формат
 * был описан в одном месте — иначе рассинхрон между кнопкой и её обработчиком
 * обнаруживается только в рантайме.
 */

// Предел длины payload на стороне платформы. Значение с запасом: длинный
// payload платформа обрежет молча, и кнопка перестанет работать.
export const MAX_PAYLOAD_LEN = 128;

export class PayloadError extends Error {}

export class MenuPayload {
  static readonly prefix = "menu";

  constructor(readonly section: string) {}

  pack(): string {
    const packed = `${MenuPayload.prefix}:${this.section}`;
    if (packed.length > MAX_PAYLOAD_LEN) {
      throw new PayloadError(
        `payload длиннее ${MAX_PAYLOAD_LEN} символов: ${JSON.stringify(packed)}`,
      );
    }
    return packed;
  }

  static unpack(raw: string): MenuPayload {
    const separator = raw.indexOf(":");
    const prefix = separator === -1 ? raw : raw.slice(0, separator);
    const section = separator === -1 ? "" : raw.slice(separator + 1);
    if (prefix !== MenuPayload.prefix || !section) {
      throw new PayloadError(`не payload меню: ${JSON.stringify(raw)}`);
    }
    return new MenuPayload(section);
  }

  static matches(raw: string): boolean {
    return raw.startsWith(`${MenuPayload.prefix}:`);
  }
}

export class BackPayload {
  static readonly prefix = "back";

  pack(): string {
    return BackPayload.prefix;
  }

  static matches(raw: string): boolean {
    return raw === BackPayload.prefix;
  }
}
