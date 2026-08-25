/** Регистрация middleware и хендлеров в диспетчере. */
import type { Dispatcher } from "../max/dispatcher.js";
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
export function registerAll(dp: Dispatcher): void {
  dp.registerOuterMiddleware(maintenanceMiddleware);
  dp.registerOuterMiddleware(new ThrottlingMiddleware().handle);

  admin.register(dp);
  start.register(dp);
  menu.register(dp);
}
