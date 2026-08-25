# Единая точка входа для всех операций проекта.
# Зависимости ставятся только через pnpm — не npm и не yarn.

.DEFAULT_GOAL := help
COMPOSE ?= docker compose

# --- Источники образов и пакетов -------------------------------------------
# Дефолты — зеркала закрытого контура. Для сборки с доступом в интернет:
#
#   BASE_IMAGE=node:22-bookworm-slim \
#   POSTGRES_IMAGE=postgres:16-alpine \
#   USE_NEXUS_APT=0 \
#   make up-local
#
# Движок тоже переопределяется: COMPOSE='podman compose' make up-local
BASE_IMAGE ?= harbor.volganet.ru/dockerhub-proxy/node:22-bookworm-slim
POSTGRES_IMAGE ?= harbor.volganet.ru/dockerhub-proxy/postgres:16-alpine
USE_NEXUS_APT ?= 1
export BASE_IMAGE POSTGRES_IMAGE USE_NEXUS_APT

DC_LOCAL := $(COMPOSE) --env-file .env -f docker/docker-compose.local.yml
DC_PROD  := $(COMPOSE) --env-file .env -f docker/docker-compose.prod.yml
GITEA_URL := https://gitea.volganet.ru

.PHONY: help init install run build lint format test check \
        up-local up-local-db down-local restart-local logs \
        up-prod down-prod migrate migration dump restore clean

help: ## Показать список целей
	@grep -hE '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# --- Разработка -------------------------------------------------------------

init: ## Создать новый проект из шаблона (интерактивно)
	pnpm run init-project

install: ## Установить зависимости
	pnpm install

run: ## Запустить бота локально
	pnpm exec tsx src/index.ts

build: ## Собрать TypeScript в dist/
	pnpm build

lint: ## Проверить код (biome check)
	pnpm lint

format: ## Отформатировать код и починить импорты
	pnpm format

test: ## Прогнать тесты
	pnpm test

check: lint test build ## Полная проверка перед коммитом

# --- Docker -----------------------------------------------------------------
# --env-file .env обязателен: без него Compose ищет .env рядом с самим
# compose-файлом (то есть в docker/), и подстановка ${PORT} в ports: молча
# берёт дефолт. env_file: внутри compose — другой механизм, он передаёт
# переменные в контейнер и подстановку в YAML не заменяет.

up-local: ## Поднять бота локально в Docker
	$(DC_LOCAL) up -d --build

up-local-db: ## Поднять бота вместе с Postgres (профиль db)
	$(DC_LOCAL) --profile db up -d --build

down-local: ## Остановить локальный стек
	$(DC_LOCAL) --profile db down

restart-local: ## Пересобрать и перезапустить локальный стек
	$(DC_LOCAL) down
	$(DC_LOCAL) up -d --build

logs: ## Логи бота в реальном времени
	$(DC_LOCAL) logs -f bot

up-prod: ## Поднять прод-конфигурацию
	$(DC_PROD) up -d

down-prod: ## Остановить прод-конфигурацию
	$(DC_PROD) down

# --- База данных (только при DATABASE_URL) -----------------------------------

migrate: ## Применить миграции
	set -a; . ./.env; set +a; pnpm migrate

migration: ## Создать ревизию: make migration m="добавил users"
	@test -n "$(m)" || { echo "Укажите описание: make migration m=\"добавил users\""; exit 1; }
	set -a; . ./.env; set +a; pnpm migration $(m)

dump: ## Дамп локальной БД: make dump [f=backup.dump]
	$(DC_LOCAL) exec -T db sh -c 'pg_dump -Fc -U "$$POSTGRES_USER" "$$POSTGRES_DB"' \
		> $(or $(f),dump_local_$(shell date +%Y%m%d_%H%M%S).dump)

restore: ## Восстановить БД из дампа: make restore f=backup.dump
	@test -n "$(f)" || { echo "Укажите файл: make restore f=backup.dump"; exit 1; }
	$(DC_LOCAL) exec -T db sh -c \
		'pg_restore --clean --if-exists --no-owner -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"' < $(f)

# --- Прочее -----------------------------------------------------------------

clean: ## Удалить кэши и временные артефакты
	rm -rf dist coverage .vitest-cache
