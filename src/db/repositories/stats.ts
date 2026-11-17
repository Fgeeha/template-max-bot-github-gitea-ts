/** Статистика открытий разделов (таблица section_views). */
import { createHmac } from "node:crypto";
import type { Queryable } from "../pool.js";

/** Необратимый идентификатор посетителя: HMAC-SHA256, первые 32 hex-символа. */
export function userHash(userId: number, salt: string): string {
  return createHmac("sha256", salt).update(String(userId)).digest("hex").slice(0, 32);
}

export interface SectionStat {
  /** null — раздел удалён. */
  title: string | null;
  opens: number;
  users: number;
}

export interface StatsReport {
  days: number;
  opens: number;
  users: number;
  top: SectionStat[];
}

export class StatsRepository {
  constructor(private readonly db: Queryable) {}

  async record(sectionId: number, visitor: string): Promise<void> {
    await this.db.query("INSERT INTO section_views (section_id, user_hash) VALUES ($1, $2)", [
      sectionId,
      visitor,
    ]);
  }

  async report(days: number, top: number): Promise<StatsReport> {
    const since = new Date(Date.now() - days * 86_400_000);
    const totals = await this.db.query(
      `SELECT count(*)::int AS opens, count(DISTINCT user_hash)::int AS users
       FROM section_views WHERE created_at >= $1`,
      [since],
    );
    // Удалённые разделы (section_id = NULL) сливаются в одну строку.
    const { rows } = await this.db.query(
      `SELECT s.title, count(v.id)::int AS opens, count(DISTINCT v.user_hash)::int AS users
       FROM section_views v LEFT JOIN sections s ON s.id = v.section_id
       WHERE v.created_at >= $1
       GROUP BY v.section_id, s.title
       ORDER BY opens DESC
       LIMIT $2`,
      [since, top],
    );
    return {
      days,
      opens: Number(totals.rows[0]?.opens ?? 0),
      users: Number(totals.rows[0]?.users ?? 0),
      top: rows.map((row) => ({
        title: (row.title as string | null) ?? null,
        opens: Number(row.opens),
        users: Number(row.users),
      })),
    };
  }
}
