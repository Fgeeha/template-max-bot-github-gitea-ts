/** Репозиторий разделов меню (дерево `sections`). */
import type { Section } from "../models.js";
import type { Queryable } from "../pool.js";

const COLUMNS = "id, parent_id, title, text, position, url, image_token";

/** Узел файла экспорта — формат описан в handlers/inputs.ts (parseTree). */
export interface TreeNode {
  title: string;
  text: string;
  url: string | null;
  image_token: string | null;
  children: TreeNode[];
}

function mapRow(row: Record<string, unknown>): Section {
  return {
    id: Number(row.id),
    parentId: row.parent_id === null ? null : Number(row.parent_id),
    title: row.title as string,
    text: row.text as string,
    position: Number(row.position),
    url: (row.url as string | null) ?? null,
    imageToken: (row.image_token as string | null) ?? null,
  };
}

export class SectionRepository {
  constructor(private readonly db: Queryable) {}

  async get(sectionId: number): Promise<Section | undefined> {
    const { rows } = await this.db.query(`SELECT ${COLUMNS} FROM sections WHERE id = $1`, [
      sectionId,
    ]);
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  /**
   * Корень дерева. Штатно его создаёт миграция со стартовым наполнением;
   * запасной корень нужен, только если таблицу очистили вручную, — иначе
   * /start упал бы.
   */
  async root(): Promise<Section> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM sections WHERE parent_id IS NULL ORDER BY id LIMIT 1`,
    );
    if (rows[0]) return mapRow(rows[0]);
    const created = await this.db.query(
      `INSERT INTO sections (parent_id, title, text) VALUES (NULL, $1, $2) RETURNING ${COLUMNS}`,
      ["Главное меню", "Выберите раздел 👇"],
    );
    return mapRow(created.rows[0] as Record<string, unknown>);
  }

  async children(parentId: number): Promise<Section[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM sections WHERE parent_id = $1 ORDER BY position, id`,
      [parentId],
    );
    return rows.map(mapRow);
  }

  /** Сколько разделов уйдёт вместе с этим при удалении. */
  async countDescendants(sectionId: number): Promise<number> {
    const { rows } = await this.db.query(
      `WITH RECURSIVE branch AS (
         SELECT id FROM sections WHERE parent_id = $1
         UNION ALL
         SELECT s.id FROM sections s JOIN branch b ON s.parent_id = b.id
       )
       SELECT count(*)::int AS count FROM branch`,
      [sectionId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Цепочка от корня до раздела включительно. */
  async path(section: Section): Promise<Section[]> {
    const chain = [section];
    let parentId = section.parentId;
    while (parentId !== null) {
      const parent = await this.get(parentId);
      if (!parent) break;
      chain.push(parent);
      parentId = parent.parentId;
    }
    return chain.reverse();
  }

  /** Добавляет подраздел последним среди соседей. */
  async add(parentId: number, title: string): Promise<Section> {
    const { rows } = await this.db.query(
      `INSERT INTO sections (parent_id, title, text, position)
       VALUES ($1, $2, '',
         (SELECT coalesce(max(position), -1) + 1 FROM sections WHERE parent_id = $1))
       RETURNING ${COLUMNS}`,
      [parentId, title],
    );
    return mapRow(rows[0] as Record<string, unknown>);
  }

  /** Сохраняет правку раздела: название, текст, ссылку, картинку. */
  async save(section: Section): Promise<void> {
    await this.db.query(
      "UPDATE sections SET title = $2, text = $3, url = $4, image_token = $5 WHERE id = $1",
      [section.id, section.title, section.text, section.url, section.imageToken],
    );
  }

  /** Удаляет раздел вместе с веткой (каскад на стороне БД). */
  async delete(sectionId: number): Promise<void> {
    await this.db.query("DELETE FROM sections WHERE id = $1", [sectionId]);
  }

  /**
   * Сдвигает раздел на одну позицию: step=-1 — выше, +1 — ниже.
   * false — двигать некуда (раздел уже крайний).
   */
  async move(section: Section, step: -1 | 1): Promise<boolean> {
    if (section.parentId === null) return false;
    const siblings = await this.children(section.parentId);
    const index = siblings.findIndex((s) => s.id === section.id);
    const target = index + step;
    if (index < 0 || target < 0 || target >= siblings.length) return false;
    const moved = siblings.splice(index, 1);
    siblings.splice(target, 0, ...moved);
    // Перенумеровываем всех соседей: порядок остаётся однозначным, даже если
    // позиции когда-то совпали.
    for (const [position, sibling] of siblings.entries()) {
      await this.db.query("UPDATE sections SET position = $2 WHERE id = $1", [
        sibling.id,
        position,
      ]);
    }
    return true;
  }

  /** Дерево от корня — формат файла экспорта. */
  async exportTree(): Promise<TreeNode> {
    return this.dump(await this.root());
  }

  private async dump(section: Section): Promise<TreeNode> {
    const children: TreeNode[] = [];
    for (const child of await this.children(section.id)) children.push(await this.dump(child));
    return {
      title: section.title,
      text: section.text,
      url: section.url,
      image_token: section.imageToken,
      children,
    };
  }

  /**
   * Заменяет всё дерево присланным; возвращает новый корень.
   *
   * Узлы получают новые id, поэтому старые кнопки в чатах перестают вести в
   * разделы (пользователь получит главное меню), а открытия в статистике
   * уходят в «удалённые разделы».
   */
  async replaceTree(tree: TreeNode): Promise<Section> {
    await this.db.query("DELETE FROM sections");
    return this.load(tree, null, 0);
  }

  private async load(node: TreeNode, parentId: number | null, position: number): Promise<Section> {
    const { rows } = await this.db.query(
      `INSERT INTO sections (parent_id, title, text, url, image_token, position)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
      [parentId, node.title, node.text, node.url, node.image_token, position],
    );
    const section = mapRow(rows[0] as Record<string, unknown>);
    for (const [index, child] of node.children.entries()) {
      await this.load(child, section.id, index);
    }
    return section;
  }
}
