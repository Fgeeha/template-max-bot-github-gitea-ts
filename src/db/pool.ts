/**
 * Пул соединений Postgres (опционально, при DATABASE_URL).
 *
 * pg — optionalDependency, импортируется лениво: бот без БД не платит за
 * пакет и не открывает соединений.
 */
import type { Pool, PoolClient } from "pg";
import { getSettings } from "../config.js";

let pool: Pool | undefined;

/** Возвращает singleton пула. Создаётся лениво — до первого обращения соединения не открываются. */
export async function getPool(): Promise<Pool> {
  if (!pool) {
    const settings = getSettings();
    if (!settings.databaseUrl) {
      throw new Error("DATABASE_URL не задан — слой БД недоступен");
    }
    const { Pool: PgPool } = await import("pg");
    pool = new PgPool({
      connectionString: settings.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

/** Транзакция: commit при успехе, rollback при исключении. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await (await getPool()).connect();
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
