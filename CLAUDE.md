# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Правила работы для агента в этом репозитории. Читать перед каждой задачей.

---

## 0. ЗАПРЕТЫ В КОММИТАХ И ИСТОРИИ (жёстко, без исключений)

Эти правила имеют наивысший приоритет. Нарушение = откатить коммит.

- В сообщениях коммитов, в теле PR, в комментариях кода, в `CHANGELOG`, в авторстве
  и в любых артефактах репозитория **ЗАПРЕЩЕНО** упоминать: `Claude`, `Anthropic`,
  `claude.ai`, `claude code`, `AI`, `ИИ`, `сгенерировано`, `assistant`, `LLM`,
  «при помощи нейросети» и любые синонимы, прямо или косвенно указывающие на
  происхождение кода от ИИ-ассистента.
- **НЕ добавлять** трейлеры вида `Co-Authored-By: Claude ...`,
  `Generated with ...`, `🤖 ...` и подобные. Коммиты должны выглядеть как
  написанные человеком-разработчиком.
- **НЕ менять** `user.name` / `user.email` в git-конфиге. Использовать те, что
  уже настроены в окружении. Если они не настроены — остановиться и спросить.
- Сообщения коммитов — на русском, в стиле Conventional Commits
  (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`), по делу, без воды и эмодзи.
- Перед каждым `git commit` мысленно проверить тело и заголовок на наличие
  запрещённых слов. Если хоть одно есть — переписать.

---

## Команды

```bash
make install                    # pnpm install
make run                        # миграции + запуск локально (polling), база — make up-local-db
make build                      # tsc -p tsconfig.json → dist/
make lint                       # biome check src tests scripts
make format                     # biome check --write (форматирование + импорты)
make test                       # vitest run
make check                      # lint + test + build — обязательно перед коммитом
```

Один тест / файл теста:

```bash
pnpm exec vitest run tests/throttling.test.ts
pnpm exec vitest run -t "разбирает список admin id"
```

БД обязательна (`DATABASE_URL`, разделы меню живут в Postgres):

```bash
make up-local-db                          # только Postgres в Docker на 127.0.0.1:5433
make migration m="добавил таблицу"        # новая ревизия node-pg-migrate
make migrate                              # применить (sourced из .env)
```

Docker: `make up-local` (бот + Postgres, миграции при старте контейнера) / `down-local` / `logs`.
Все compose-вызовы обязаны идти через `--env-file .env` (Makefile это делает сам) — без
флага Compose ищет `.env` в `docker/` и подстановка `${PORT}` молча берёт дефолт.

`make docs` — HTML-документация из `README.md` и `docs/*.md` в `docs/html/`
(`scripts/build-docs.ts`).

`make help` — полный список целей прямо из Makefile.

Пакетный менеджер — только `pnpm` (через `corepack`), не `npm`/`yarn`.

---

## Архитектура

Официальный клиент [`@maxhub/max-bot-api`](https://github.com/max-messenger/max-bot-api-client-ts)
(Telegraf-подобный API: `bot.command()`/`bot.hears()`/`bot.action()`, `ctx.reply()`) даёт
диспетчер и HTTP-слой, но поддерживает только long polling — webhook и лимиты в нём нет.
Шаблон достраивает недостающее вокруг него:

- **`src/runtime.ts`** патчит `globalThis.fetch` — это единственная точка перехвата,
  так как клиент не даёт своих хуков. Отсюда идут: ограничение RPS к API,
  отдельный лимит на отправку сообщений, ретраи на 429, подключение кастомного CA
  (`MAX_CA_BUNDLE` / `certs/`).
- **`src/webhook.ts`** — свой `node:http`-сервер. Роут отвечает MAX сразу, а обработка
  уходит в фоновую задачу (HTTP-соединение не держится). Очередь ограничена
  `WEBHOOK_MAX_PENDING_UPDATES`; сверх лимита — 503. Размер очереди виден в `/healthz`
  (`pending_updates`). При остановке ждёт `WEBHOOK_DRAIN_TIMEOUT` секунд, но не может
  отменить уже запущенные обработчики (в JS `Promise` не отменяем, в отличие от
  `asyncio.Task` в Python-версии шаблона) — по истечении таймаута просто перестаёт ждать.
- **`src/maxWebhookSubscription.ts`** — подписка/отписка от webhook, написана вручную
  и промаркирована как best-effort: единственный путь API (`/subscriptions`), который
  официальный клиент не покрывает.
- И webhook, и polling прогоняют апдейты через один и тот же `bot.middleware()` /
  `registerAll()`, поэтому вся маршрутизация в `handlers/` работает одинаково в обоих
  режимах.

**Порядок регистрации в `src/handlers/index.ts` значим** и жёстко закомментирован в
файле: сначала outer middleware (`maintenance` → гейт доступа, затем `throttling` — не
тратить лимит на заблокированного клиента), затем хендлеры команд/callback'ов, и
`menu.register()` — последним, потому что у него catch-all на свободный текст, который
иначе перехватит команды, зарегистрированные после него.

Внутри хендлеров: `admin.register` → `editor.register` (админка: `/admin`,
`bot.action(/^a:/)`, middleware ожидаемого ввода — пропускает команды через `next()`) →
`start.register` → `menu.register`. Хендлеры регистрирует `registerHandlers()` — его же
вызывают сценарные тесты, без middleware.

**Уровни доступа** (три независимых слоя, не путать друг с другом):
1. `middlewares/maintenance.ts` — при `PROD=false` пропускает только владельцев
   (`ADMIN_IDS`; администраторов из `staff` — нет), в группах при блокировке молчит.
2. `middlewares/throttling.ts` — не чаще одного события на пользователя в 0.5с,
   состояние в памяти процесса (при нескольких репликах — приблизительно, для честного
   лимита нужен Redis).
3. Роли в `handlers/admin.ts`: владелец — `ADMIN_IDS` (всё, включая управление
   администраторами), администратор — таблица `staff`, читается из БД на каждом событии.
   `adminOnly` — неадминам `/admin`, `/v`, `/status` не отвечают вовсе (само наличие ответа
   «недостаточно прав» раскрывало бы скрытую функциональность).

**Конфигурация** — единый источник правды в `src/config.ts` (zod-схема + ручные
проверки), читается из окружения при старте, а не лениво при первом обращении: бот
не запустится с `BOT_MODE=webhook` без `WEBHOOK_SECRET`. Полный список переменных с
комментариями — `.env.example`. `src/config.ts` не грузит `.env`, когда выставлена
`VITEST` (ставится vitest автоматически) — тесты герметичны и в сеть не ходят.

**БД обязательна, метрики — нет.** `pg` и `node-pg-migrate` — обычные `dependencies`
(миграции применяются при старте контейнера, см. `CMD` в `docker/Dockerfile`),
`prom-client` — `optionalDependencies`, импортируется лениво. Весь SQL живёт в
`src/db/repositories/` — хендлеры работают только через `withTransaction()` из
`src/db/pool.ts`. Ответы в MAX отправляются после commit, а не внутри транзакции.
Начальная миграция — чистый SQL через `pgm.sql()` (схема + демо-разделы): тесты
прогоняют её на PGlite без раннера.

**Меню — дерево в БД, правится в админке.** Таблица `sections` (корень `parent_id IS NULL`
— приветствие на `/start`), экран админки — `handlers/screens.ts`, действия над разделом —
`handlers/editor.ts`, инструменты главного экрана (администраторы, статистика, JSON-файл,
журнал) — `handlers/tools.ts`, проверка ввода и файла импорта — `handlers/inputs.ts`.
Payload'ы — `SectionPayload` (`s:<id>`) и `AdminPayload` (`a:<action>:<target>`) в
`keyboards/callbacks.ts`. Ожидание ввода (`handlers/pending.ts`) — в памяти процесса.
Длины (64 на кнопку, 4000 на текст) считаются в символах Unicode (`charLength`), не в
`String.length`. Формат файла разделов (`max-bot-sections` v1) общий с Python-версией.
Пользовательская навигация (`handlers/menu.ts::showInPlace`) правит сообщение с кнопкой;
при 4xx — подтверждение нажатия + новое сообщение, при 5xx — ничего (правка могла
пройти), отклонённая картинка — повтор без неё.

**Тесты.** Сценарные (`tests/editorFlow`, `editorImages`, `tools`) гоняют апдейты через
настоящую цепочку `registerHandlers()` с `FakeApi` из `tests/helpers/bot.ts`; БД —
PGlite через `vi.mock("../src/db/pool.js", …)` из `tests/helpers/db.ts`
(`beforeEach(resetDb)`; `resetDb(true)` — с демо-разделами).

**CI/CD.** GitHub Actions (`.github/workflows/ci.yml`): lint → test → build → образ в
GHCR. Gitea Actions — **один файл** `.gitea/workflows/pipeline.yml` на весь цикл
(lint → test → build → release-image → deploy → rollback), потому что в Gitea Actions
нет `workflow_run` и нечем связать отдельные `ci.yml`/`cd.yml`. Не добавлять второй
workflow-файл с теми же триггерами — Gitea прогоняет каждый файл в `.gitea/workflows/`
независимо, будет двойной прогон. Деплой триггерится тегом `vX.Y.Z`, откат — автоматически
при провале health-проверки, предыдущий тег хранится в `.image_tag.previous` на прод-хосте.

**Закрытый контур по умолчанию**: `BASE_IMAGE`/`POSTGRES_IMAGE` указывают на внутренние
зеркала (`harbor.volganet.ru`, `nexus.volganet.ru`), переопределяются через переменные
окружения Makefile (см. секцию «Источники образов» в `Makefile`). GitHub CI всегда
собирает с публичными источниками.

**Разница с Python-версией шаблона** (`../template-max-bot-github-gitea`) — та же
архитектура и та же админка, но: официальный SDK вместо `maxapi`; лимиты патчат
`globalThis.fetch` вместо конкретного класса; webhook-сервер на голом `node:http` вместо
FastAPI; SQL через `pg` + node-pg-migrate вместо SQLAlchemy + Alembic, тесты на PGlite
вместо SQLite; `optionalDependencies` вместо `extras`; `drain()` не может отменить фоновые
задачи. Подробности — README, раздел «Отличия от Python-версии».

Соглашение по размеру файлов: до 400 строк, при превышении — делить на модули.
