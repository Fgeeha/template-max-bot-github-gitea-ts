/** Регистрация middleware и хендлеров в диспетчере. */
import type { Composer, Context } from "@maxhub/max-bot-api";
import { maintenanceMiddleware } from "../middlewares/maintenance.js";
import { ThrottlingMiddleware } from "../middlewares/throttling.js";
import * as admin from "./admin.js";
import * as editor from "./editor.js";
import * as menu from "./menu.js";
import * as start from "./start.js";

/** Bot и голый Composer (в тестах) — хендлерам нужен только диспетчер. */
export type Dispatcher = Composer<Context>;

/**
 * Подключает всё, что обрабатывает события.
 *
 * Порядок значим:
 *   1. outer middleware — до фильтров: сначала гейт доступа, затем лимиты
 *      (не имеет смысла тратить слот лимита на заблокированного клиента);
 *   2. хендлеры — см. registerHandlers.
 */
export function registerAll(bot: Dispatcher): void {
  bot.use(maintenanceMiddleware);
  bot.use(new ThrottlingMiddleware().handle);
  registerHandlers(bot);
}

/**
 * Хендлеры команд и callback'ов — со своими фильтрами. Админка (editor) — до
 * menu, иначе её кнопки и ввод заберёт пользовательская навигация; catch-all
 * для свободного текста и кнопок (menu) — последним.
 */
export function registerHandlers(bot: Dispatcher): void {
  admin.register(bot);
  editor.register(bot);
  start.register(bot);
  menu.register(bot);
}
