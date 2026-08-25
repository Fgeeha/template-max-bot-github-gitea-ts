/** Ошибка ответа MAX Bot API. */
export class MaxApiError extends Error {
  readonly code: number;
  readonly raw: unknown;

  constructor(code: number, raw: unknown) {
    super(`MAX API error ${code}: ${JSON.stringify(raw)}`);
    this.name = "MaxApiError";
    this.code = code;
    this.raw = raw;
  }
}
