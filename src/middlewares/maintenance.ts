/**
 * Maintenance-гейт: пока PROD=false, бот отвечает только администраторам.
 *
 * Регистрируется как outer middleware — перехватывает сообщения, callback'и
 * и bot_started единым кодом, до того как сработают фильтры хендлеров.
 */
import { getSettings } from "../config.js";
import type { Middleware } from "../max/dispatcher.js";
import {
  BotStarted,
  ChatType,
  MessageCallback,
  MessageCreated,
  type UpdateEvent,
} from "../max/types.js";

export const MAINTENANCE_TEXT = "Бот в разработке, скоро откроется.";

export const maintenanceMiddleware: Middleware = async (next, event) => {
  const settings = getSettings();
  if (!settings.isMaintenance) {
    await next();
    return;
  }

  const ids = event.getIds();
  // Системные события без user_id пропускаем: блокировать нечего и некого.
  if (!ids?.userId) {
    await next();
    return;
  }

  if (settings.adminIdsSet.has(ids.userId)) {
    await next();
    return;
  }

  await notify(event);
};

/** Сообщает о недоступности способом, подходящим типу события. */
async function notify(event: UpdateEvent): Promise<void> {
  try {
    if (event instanceof MessageCallback) {
      // На callback единственный корректный ответ — всплывающее уведомление;
      // отправка сообщения оставит «часики» на кнопке.
      await event.answer({ notification: MAINTENANCE_TEXT });
    } else if (event instanceof MessageCreated) {
      // В группах молчим: ответ на каждое упоминание превращается в спам.
      if (event.message.recipient.chatType !== ChatType.Dialog) return;
      await event.message.answer({ text: MAINTENANCE_TEXT });
    } else if (event instanceof BotStarted) {
      await event.bot.sendMessageToUser({ userId: event.userId, text: MAINTENANCE_TEXT });
    }
    // Остальные системные события игнорируем молча.
  } catch (error) {
    // Не даём сбою уведомления сломать обработку события.
    console.warn("maintenance: не удалось отправить заглушку:", error);
  }
}
