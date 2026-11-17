/** Журнал изменений админки (таблица audit_log). */
import type { AuditEntry } from "../models.js";
import type { Queryable } from "../pool.js";

export class AuditRepository {
  constructor(private readonly db: Queryable) {}

  /** Запись в той же транзакции, что и правка: откатится правка — откатится и запись. */
  async log(userId: number, details: string): Promise<void> {
    await this.db.query("INSERT INTO audit_log (user_id, details) VALUES ($1, $2)", [
      userId,
      details,
    ]);
  }

  async recent(limit: number): Promise<AuditEntry[]> {
    const { rows } = await this.db.query(
      "SELECT id, user_id, details, created_at FROM audit_log ORDER BY id DESC LIMIT $1",
      [limit],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      userId: Number(row.user_id),
      details: row.details as string,
      createdAt: new Date(row.created_at as Date),
    }));
  }
}
