/** Регистрация middleware и хендлеров в диспетчере. */
import type { Bot } from "@maxhub/max-bot-api";
import { maintenanceMiddleware } from "../middlewares/maintenance.js";
import { ThrottlingMiddleware } from "../middlewares/throttling.js";
import * as admin from "./admin.js";
import * as menu from "./menu.js";
import * as start from "./start.js";

/**
 * Подключает всё, что обрабатывает события.
 *
 * Порядок значим:
 *   1. outer middleware — до фильтров: сначала гейт доступа, затем лимиты
 *      (не имеет смысла тратить слот лимита на заблокированного клиента);
 *   2. хендлеры команд и callback'ов — со своими фильтрами;
 *   3. catch-all для свободного текста — последним, иначе перехватит всё.
 */
export function registerAll(bot: Bot): void {
  bot.use(maintenanceMiddleware);
  bot.use(new ThrottlingMiddleware().handle);

  admin.register(bot);
  start.register(bot);
  menu.register(bot);
}
