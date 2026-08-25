/**
 * Maintenance-гейт: пока PROD=false, бот отвечает только администраторам.
 *
 * Регистрируется через bot.use() — перехватывает сообщения, callback'и и
 * bot_started единым кодом, до того как сработают фильтры хендлеров.
 */
import type { Context, MiddlewareFn, NextFn } from "@maxhub/max-bot-api";
import { getSettings } from "../config.js";

export const MAINTENANCE_TEXT = "Бот в разработке, скоро откроется.";

export const maintenanceMiddleware: MiddlewareFn<Context> = async (ctx, next: NextFn) => {
  const settings = getSettings();
  if (!settings.isMaintenance) {
    await next();
    return;
  }

  const userId = ctx.user?.user_id;
  // Системные события без user_id пропускаем: блокировать нечего и некого.
  if (userId === undefined) {
    await next();
    return;
  }

  if (settings.adminIdsSet.has(userId)) {
    await next();
    return;
  }

  await notify(ctx);
};

/** Сообщает о недоступности способом, подходящим типу события. */
async function notify(ctx: Context): Promise<void> {
  try {
    if (ctx.has("message_callback")) {
      // На callback единственный корректный ответ — всплывающее уведомление;
      // отправка сообщения оставит «часики» на кнопке.
      await ctx.answerOnCallback({ notification: MAINTENANCE_TEXT });
      return;
    }
    if (ctx.has("message_created")) {
      // В группах молчим: ответ на каждое упоминание превращается в спам.
      if (ctx.message.recipient.chat_type !== "dialog") return;
      await ctx.reply(MAINTENANCE_TEXT);
      return;
    }
    if (ctx.has("bot_started")) {
      await ctx.reply(MAINTENANCE_TEXT);
    }
    // Остальные системные события игнорируем молча.
  } catch (error) {
    // Не даём сбою уведомления сломать обработку события.
    console.warn("maintenance: не удалось отправить заглушку:", error);
  }
}
