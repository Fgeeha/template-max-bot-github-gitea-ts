/**
 * Postgres для тестов — PGlite (Postgres в WASM, в процессе, без сети).
 *
 * Схема и демо-разделы берутся из той же миграции, что и в проде. Подключение
 * в тестовом файле:
 *
 *   vi.mock("../src/db/pool.js", () => import("./helpers/db.js").then((m) => m.poolMock));
 *   beforeEach(resetDb);
 */
import { PGlite } from "@electric-sql/pglite";
// @ts-expect-error — JS-миграция без типов, нужна только её функция up.
import { up } from "../../migrations/1763294400000_initial.js";
import type { Queryable } from "../../src/db/pool.js";

const statements: string[] = [];
up({ sql: (text: string) => statements.push(text) });
const [SCHEMA, SEED] = statements as [string, string];

let db: PGlite | undefined;

/**
 * Схема с нуля один раз на файл, дальше — чистые таблицы перед каждым тестом.
 * Без seed корня нет — его создаёт запасной путь SectionRepository.root().
 */
export async function resetDb(seed = false): Promise<void> {
  if (!db) {
    db = new PGlite();
    await db.exec(SCHEMA);
  }
  await db.exec("TRUNCATE sections, staff, section_views, audit_log RESTART IDENTITY CASCADE");
  if (seed) await db.exec(SEED);
}

function current(): PGlite {
  if (!db) throw new Error("resetDb() не вызван");
  return db;
}

/** Прямые запросы из тестов — проверить, что лежит в таблицах. */
export function query<R = Record<string, unknown>>(text: string, values?: unknown[]) {
  return current().query<R>(text, values);
}

export const poolMock = {
  withTransaction: <T>(fn: (db: Queryable) => Promise<T>): Promise<T> =>
    current().transaction((tx) => fn(tx as unknown as Queryable)),
  disposePool: async (): Promise<void> => {},
};
