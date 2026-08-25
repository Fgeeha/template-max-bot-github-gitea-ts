/**
 * Prometheus-метрики (опционально).
 *
 * Включается флагом METRICS_ENABLED. Сервер поднимается на отдельном порту и
 * наружу не публикуется — его забирает Prometheus изнутри сети. prom-client —
 * optionalDependency (см. package.json), импортируется лениво, чтобы бот без
 * метрик не платил за пакет.
 */
import type { Counter } from "prom-client";

interface Metrics {
  updates: Counter<string>;
  errors: Counter<string>;
}

let metrics: Metrics | undefined;

async function buildCounters(): Promise<Metrics> {
  const { Counter } = await import("prom-client");
  return {
    updates: new Counter({
      name: "bot_updates_total",
      help: "Количество обработанных апдейтов",
      labelNames: ["type"],
    }),
    errors: new Counter({
      name: "bot_errors_total",
      help: "Количество ошибок при обработке апдейтов",
      labelNames: ["kind"],
    }),
  };
}

/** Возвращает singleton набора счётчиков. */
export async function getMetrics(): Promise<Metrics> {
  if (!metrics) metrics = await buildCounters();
  return metrics;
}

/** Извлекает порт из строки вида ':9090' или 'host:9090'. */
export function parseMetricsPort(metricsAddr: string): number {
  const parts = metricsAddr.split(":");
  return Number(parts[parts.length - 1]);
}

/** Поднимает HTTP-сервер метрик. */
export async function startMetricsServer(metricsAddr: string): Promise<void> {
  const { register } = await import("prom-client");
  const { createServer } = await import("node:http");
  await getMetrics();

  const port = parseMetricsPort(metricsAddr);
  const server = createServer((req, res) => {
    if (req.url === "/metrics") {
      void register.metrics().then((body) => {
        res.writeHead(200, { "content-type": register.contentType });
        res.end(body);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port);
  console.info(`Prometheus-метрики доступны на порту ${port}`);
}
