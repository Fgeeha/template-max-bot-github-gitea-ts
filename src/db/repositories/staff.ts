/** Репозиторий администраторов, добавленных через админку (таблица staff). */
import type { Staff } from "../models.js";
import type { Queryable } from "../pool.js";

export class StaffRepository {
  constructor(private readonly db: Queryable) {}

  async exists(userId: number): Promise<boolean> {
    const { rows } = await this.db.query("SELECT 1 FROM staff WHERE user_id = $1", [userId]);
    return rows.length > 0;
  }

  async all(): Promise<Staff[]> {
    const { rows } = await this.db.query(
      "SELECT user_id, added_by, created_at FROM staff ORDER BY created_at, user_id",
    );
    return rows.map((row) => ({
      userId: Number(row.user_id),
      addedBy: row.added_by === null ? null : Number(row.added_by),
      createdAt: new Date(row.created_at as Date),
    }));
  }

  /** false — такой администратор уже есть. */
  async add(userId: number, addedBy: number): Promise<boolean> {
    const { rows } = await this.db.query(
      `INSERT INTO staff (user_id, added_by) VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
      [userId, addedBy],
    );
    return rows.length > 0;
  }

  /** false — такого администратора не было. */
  async remove(userId: number): Promise<boolean> {
    const { rows } = await this.db.query("DELETE FROM staff WHERE user_id = $1 RETURNING user_id", [
      userId,
    ]);
    return rows.length > 0;
  }
}
