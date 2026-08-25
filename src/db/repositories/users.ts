/** Репозиторий пользователей — образец для остальных репозиториев. Весь SQL держится здесь. */
import type { User } from "../models.js";

/** Общий интерфейс Pool и PoolClient из pg — репозиторий не привязан к конкретному. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

function mapRow(row: Record<string, unknown>): User {
  return {
    userId: Number(row.user_id),
    username: (row.username as string | null) ?? null,
    createdAt: row.created_at as Date,
    lastSeenAt: row.last_seen_at as Date,
  };
}

export class UserRepository {
  constructor(private readonly client: Queryable) {}

  async get(userId: number): Promise<User | undefined> {
    const result = await this.client.query(
      "SELECT user_id, username, created_at, last_seen_at FROM users WHERE user_id = $1",
      [userId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  /**
   * Создаёт пользователя или обновляет время последнего визита.
   *
   * INSERT ... ON CONFLICT, а не «прочитать и решить»: два одновременных
   * события от одного пользователя иначе гонятся за вставку, и один из
   * запросов падает на нарушении первичного ключа.
   */
  async upsert(userId: number, username: string | null = null): Promise<void> {
    await this.client.query(
      `INSERT INTO users (user_id, username)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username, last_seen_at = now()`,
      [userId, username],
    );
  }

  async count(): Promise<number> {
    const result = await this.client.query("SELECT count(*)::int AS count FROM users");
    return Number(result.rows[0]?.count ?? 0);
  }
}
