# Multi-stage сборка: base (зависимости + сборка) → test / runtime.
#
# Все внешние источники параметризованы через ARG. По умолчанию — зеркала
# закрытого контура; для сборки с доступом в интернет переопределите:
#   docker build \
#     --build-arg BASE_IMAGE=node:22-bookworm-slim \
#     --build-arg USE_NEXUS_APT=0 \
#     -f docker/Dockerfile .

# ARG до первого FROM — иначе его нельзя подставить в сам FROM.
ARG BASE_IMAGE="harbor.volganet.ru/dockerhub-proxy/node:22-bookworm-slim"

# ---------------------------------------------------------------------------
# base — зависимости, код и сборка (tsc), общая основа для test и runtime
# ---------------------------------------------------------------------------
FROM ${BASE_IMAGE} AS base

# NPM_REGISTRY может содержать креды Nexus — НИКОГДА не выводить в echo и не
# писать в ENV: значение осело бы в метаданных образа в открытом виде.
ARG NPM_REGISTRY=""
ARG NEXUS_URL="https://nexus.volganet.ru"
# 1 — APT через Nexus Debian-proxy (закрытый контур); 0 — штатные репозитории.
ARG USE_NEXUS_APT="1"
# UID/GID процесса внутри контейнера. При bind-mount ./logs должны совпадать
# с пользователем на хосте, иначе бот не сможет писать логи.
ARG UID=10001
ARG GID=10001

ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH"

# Переключение APT на Nexus и обновление пакетов базового образа: закрывает
# те OS-CVE, для которых уже вышел фикс в bookworm-security. ca-certificates
# ставим явно: слим-образ Node несёт сертификаты, но не сам скрипт
# update-ca-certificates, нужный для регистрации certs/*.crt.
RUN set -eux; \
    if [ "${USE_NEXUS_APT}" = "1" ]; then \
        BASE="${NEXUS_URL%/}"; \
        rm -f /etc/apt/sources.list; \
        rm -rf /etc/apt/sources.list.d/*; \
        printf '%s\n' \
          "deb ${BASE}/repository/debian/ bookworm main contrib non-free" \
          "deb ${BASE}/repository/debian-security/ bookworm-security main contrib non-free" \
          "deb ${BASE}/repository/debian/ bookworm-updates main contrib non-free" \
          > /etc/apt/sources.list; \
    fi; \
    apt-get update; \
    apt-get -y upgrade; \
    apt-get -y dist-upgrade; \
    apt-get -y install --no-install-recommends ca-certificates; \
    apt-get -y autoremove --purge; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Дополнительные корневые сертификаты (например, УЦ Минцифры РФ), если файлы
# лежат в certs/. Каталога может не быть — COPY создаст пустой,
# update-ca-certificates идемпотентен и сборку не ломает.
COPY certs/ /usr/local/share/ca-certificates/extra/
RUN update-ca-certificates || true

RUN groupadd --system --gid ${GID} appuser \
    && useradd --system --uid ${UID} --gid appuser --no-create-home appuser \
    && mkdir -p /app/logs \
    && chown appuser:appuser /app/logs

RUN corepack enable

# Слой 1 — только манифест и лок-файл: пересобирается лишь при изменении
# зависимостей, а не на каждую правку кода.
COPY package.json pnpm-lock.yaml ./
RUN set -eux; \
    if [ -n "${NPM_REGISTRY}" ]; then pnpm config set registry "${NPM_REGISTRY}"; fi; \
    pnpm install --frozen-lockfile

# Слой 2 — исходники и сборка.
COPY . .
RUN pnpm build

# ---------------------------------------------------------------------------
# test — гоняет линт/формат и тесты внутри собранного образа (цель для CI)
# ---------------------------------------------------------------------------
FROM base AS test
CMD ["sh", "-c", "pnpm lint && pnpm test"]

# ---------------------------------------------------------------------------
# runtime — прод-образ: без dev-зависимостей, от непривилегированного пользователя
# ---------------------------------------------------------------------------
FROM base AS runtime
ARG BUILD_TAG=""
ENV BUILD_TAG=${BUILD_TAG} \
    NODE_ENV=production
# Убирает devDependencies (typescript, vitest, biome, tsx) — рантайму нужен
# только dist/ и прод-зависимости.
RUN pnpm prune --prod
USER appuser
# Порт слушается только при BOT_MODE=webhook; в polling EXPOSE — просто
# декларация для оркестратора.
EXPOSE 8081
CMD ["node", "dist/index.js"]
