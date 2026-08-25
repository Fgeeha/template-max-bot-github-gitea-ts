/** Строка таблицы users. Демонстрационная модель — замените своей предметной областью. */
export interface User {
  /** user_id платформы MAX. bigint в Postgres — идентификаторы выходят за пределы int32. */
  userId: number;
  username: string | null;
  createdAt: Date;
  lastSeenAt: Date;
}
