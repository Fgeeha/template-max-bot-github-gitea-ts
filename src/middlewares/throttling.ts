/**
 * Ограничение частоты входящих событий по пользователю.
 *
 * Защищает от «залипшей» кнопки и намеренного флуда: без этого один клиент
 * способен выдать десятки событий в секунду, каждое из которых потянет вызовы
 * MAX API и упрётся в антиспам-лимит уже на стороне платформы.
 */
import type { Context, MiddlewareFn, NextFn } from "@maxhub/max-bot-api";

// Сколько записей о пользователях держим в памяти. При превышении чистим
// протухшие — иначе Map росла бы неограниченно на публичном боте.
const MAX_TRACKED_USERS = 10_000;

/**
 * Пропускает не чаще одного события на пользователя в `rateSeconds` секунд.
 *
 * Хранит время последнего события в памяти процесса. При нескольких репликах
 * бота лимит становится «мягким» (каждая реплика считает свои события) — для
 * честного распределённого лимита нужен Redis.
 */
export class ThrottlingMiddleware {
  private readonly rateMs: number;
  private readonly lastSeen = new Map<number, number>();

  constructor(rateSeconds = 0.5) {
    this.rateMs = rateSeconds * 1000;
  }

  readonly handle: MiddlewareFn<Context> = async (ctx, next: NextFn) => {
    const userId = ctx.user?.user_id;
    if (userId === undefined) {
      await next();
      return;
    }

    const now = Date.now();
    const last = this.lastSeen.get(userId);
    if (last !== undefined && now - last < this.rateMs) {
      await reject(ctx);
      return;
    }

    this.lastSeen.set(userId, now);
    if (this.lastSeen.size > MAX_TRACKED_USERS) {
      this.evict(now);
    }
    await next();
  };

  private evict(now: number): void {
    const cutoff = now - this.rateMs;
    let removed = 0;
    for (const [userId, seen] of this.lastSeen) {
      if (seen < cutoff) {
        this.lastSeen.delete(userId);
        removed += 1;
      }
    }
    console.debug(`throttling: очищено ${removed} записей`);
  }
}

/**
 * Гасит слишком частое событие.
 *
 * На callback отвечаем уведомлением, чтобы кнопка не осталась в состоянии
 * ожидания. Сообщения игнорируем молча: предупреждение на каждое сообщение
 * само по себе стало бы флудом.
 */
async function reject(ctx: Context): Promise<void> {
  if (!ctx.has("message_callback")) return;
  try {
    await ctx.answerOnCallback({ notification: "Слишком часто, подождите секунду" });
  } catch (error) {
    console.debug("throttling: не удалось ответить на callback:", error);
  }
}
