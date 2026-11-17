/**
 * Пул соединений Postgres.
 *
 * БД обязательна: разделы меню, администраторы, статистика и журнал живут
 * в ней. Весь SQL — в src/db/repositories/, хендлеры к пулу напрямую не
 * обращаются, только через withTransaction().
 */
import pg from "pg";
import { getSettings } from "../config.js";

/**
 * То, что нужно репозиториям от соединения: pg.PoolClient и PGlite в тестах
 * подходят оба. Число строк проверяйте по RETURNING, а не по rowCount — у
 * PGlite его нет.
 */
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

let pool: pg.Pool | undefined;

/** Singleton пула. Создаётся лениво — до первого обращения соединения не открываются. */
function getPool(): pg.Pool {
  pool ??= new pg.Pool({
    connectionString: getSettings().databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return pool;
}

/** Транзакция: commit при успехе, rollback при исключении. */
export async function withTransaction<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Закрывает пул соединений при остановке бота. */
export async function disposePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
