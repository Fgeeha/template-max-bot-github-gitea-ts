/**
 * Начальная схема: разделы меню, администраторы, статистика, журнал.
 *
 * Чистый SQL через pgm.sql(): ту же миграцию тесты прогоняют на PGlite
 * (tests/helpers/db.ts) без раннера node-pg-migrate.
 */

export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE sections (
      id          serial PRIMARY KEY,
      -- ON DELETE CASCADE: удаление раздела удаляет всю ветку на стороне БД.
      parent_id   integer REFERENCES sections(id) ON DELETE CASCADE,
      -- 64 — потолок длины текста кнопки в MAX, 2048 — длины ссылки.
      title       varchar(64) NOT NULL,
      text        text NOT NULL DEFAULT '',
      position    integer NOT NULL DEFAULT 0,
      url         varchar(2048),
      image_token text
    );
    CREATE INDEX ix_sections_parent_id ON sections (parent_id);

    CREATE TABLE staff (
      -- user_id MAX выходит за пределы int32.
      user_id    bigint PRIMARY KEY,
      added_by   bigint,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- Открытия разделов. user_hash — HMAC от user_id, сам id не хранится.
    -- SET NULL: удаление раздела не меняет итоги задним числом.
    CREATE TABLE section_views (
      id         bigserial PRIMARY KEY,
      section_id integer REFERENCES sections(id) ON DELETE SET NULL,
      user_hash  varchar(32) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ix_section_views_section_id ON section_views (section_id);
    CREATE INDEX ix_section_views_created_at ON section_views (created_at);

    CREATE TABLE audit_log (
      id         bigserial PRIMARY KEY,
      user_id    bigint NOT NULL,
      details    text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ix_audit_log_created_at ON audit_log (created_at);
  `);

  // Демонстрационное наполнение — дальше правится через /admin. id не задаём
  // явно: иначе sequence не сдвинется и первая вставка из админки упадёт на
  // дубликате ключа.
  pgm.sql(`
    WITH root AS (
      INSERT INTO sections (parent_id, title, text, position)
      VALUES (NULL, 'Главное меню', E'👋 Здравствуйте!\\n\\nЭто шаблон бота-визитки для мессенджера MAX. Тексты, кнопки, картинки и ссылки меняются в админке: команда /admin в личке с ботом.\\n\\nВыберите раздел 👇', 0)
      RETURNING id
    )
    INSERT INTO sections (parent_id, title, text, url, position)
    SELECT root.id, v.title, v.text, v.url, v.position
    FROM root, (VALUES
      ('ℹ️ О нас', 'Расскажите здесь, чем вы занимаетесь и чем можете помочь.', NULL::varchar, 0),
      ('📞 Контакты', E'Телефон: +7 (000) 000-00-00\\nE-mail: info@example.ru\\nАдрес: …', NULL, 1),
      ('❓ Помощь', E'Команды:\\n/start — главное меню\\n/id — ваш MAX user ID\\n\\nКнопки под сообщением ведут по разделам.', NULL, 2),
      ('🌐 Сайт', '', 'https://max.ru', 3)
    ) AS v(title, text, url, position);
  `);
};

export const down = (pgm) => {
  pgm.sql("DROP TABLE audit_log, section_views, staff, sections;");
};
