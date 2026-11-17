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

function parseId(raw: string, value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new PayloadError(`битый id в payload: ${JSON.stringify(raw)}`);
  }
  return Number(value);
}

/** Пользователь открывает раздел. */
export class SectionPayload {
  static readonly prefix = "s";

  constructor(readonly sectionId: number) {}

  pack(): string {
    return `${SectionPayload.prefix}:${this.sectionId}`;
  }

  static unpack(raw: string): SectionPayload {
    const [prefix, value, ...rest] = raw.split(":");
    if (prefix !== SectionPayload.prefix || rest.length > 0) {
      throw new PayloadError(`не payload раздела: ${JSON.stringify(raw)}`);
    }
    return new SectionPayload(parseId(raw, value));
  }
}

/** Действия админки. Значения — часть payload, при переименовании старые кнопки устареют. */
export enum AdminAction {
  Open = "open",
  Add = "add",
  Title = "title",
  Text = "text",
  Link = "link",
  Image = "img",
  Up = "up",
  Down = "down",
  Delete = "del",
  DeleteConfirm = "delok",
  Preview = "view",
  /** Главный экран админки; цель не нужна (0). */
  Home = "home",
  // Инструменты (handlers/tools.ts). Цель — аргумент: user_id администратора,
  // число дней отчёта или 0.
  Staff = "staff",
  StaffAdd = "staffadd",
  StaffDel = "staffdel",
  StaffDelConfirm = "staffdelok",
  Stats = "stats",
  Transfer = "io",
  Export = "export",
  Import = "import",
  Log = "log",
}

const ADMIN_ACTIONS = new Set<string>(Object.values(AdminAction));

/** Кнопка админки: действие и его цель (id раздела или аргумент инструмента). */
export class AdminPayload {
  static readonly prefix = "a";

  constructor(
    readonly action: AdminAction,
    readonly target = 0,
  ) {}

  pack(): string {
    const packed = `${AdminPayload.prefix}:${this.action}:${this.target}`;
    if (packed.length > MAX_PAYLOAD_LEN) {
      throw new PayloadError(`payload длиннее ${MAX_PAYLOAD_LEN} символов: ${packed}`);
    }
    return packed;
  }

  static unpack(raw: string): AdminPayload {
    const parts = raw.split(":");
    if (parts.length !== 3 || parts[0] !== AdminPayload.prefix) {
      throw new PayloadError(`не payload админки: ${JSON.stringify(raw)}`);
    }
    const action = parts[1] as string;
    if (!ADMIN_ACTIONS.has(action)) {
      throw new PayloadError(`неизвестное действие админки: ${JSON.stringify(raw)}`);
    }
    return new AdminPayload(action as AdminAction, parseId(raw, parts[2]));
  }

  static matches(raw: string): boolean {
    return raw.startsWith(`${AdminPayload.prefix}:`);
  }
}
