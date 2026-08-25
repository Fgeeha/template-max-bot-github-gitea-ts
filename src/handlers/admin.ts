/**
 * Служебные команды для администраторов: /v, /status.
 *
 * Неадминам команды не отвечают вовсе — для стороннего пользователя их как бы
 * не существует. Это осознанный выбор: сообщение «недостаточно прав» само по
 * себе раскрывает наличие скрытой функциональности.
 */
import { getSettings } from "../config.js";
import type { Dispatcher } from "../max/dispatcher.js";
import { command } from "../max/filters.js";
import type { MessageCreated } from "../max/types.js";

// Запас от лимита платформы (~4096 символов) — длинное сообщение режем сами.
export const MAX_MESSAGE_LEN = 3800;

function adminOnly(
  handler: (event: MessageCreated) => Promise<void>,
): (event: MessageCreated) => Promise<void> {
  return async (event) => {
    const userId = event.getIds().userId;
    if (userId === undefined || !getSettings().adminIdsSet.has(userId)) return;
    await handler(event);
  };
}

export function register(dp: Dispatcher): void {
  dp.onMessageCreated(adminOnly(onVersion), command("v"));
  dp.onMessageCreated(adminOnly(onStatus), command("status"));
}

/** Тег текущей сборки — чтобы убедиться, что на проде именно та версия. */
async function onVersion(event: MessageCreated): Promise<void> {
  const settings = getSettings();
  const text = settings.buildTag ? `Версия: \`${settings.buildTag}\`` : "Тег сборки не задан.";
  await event.message.answer({ text });
}

async function onStatus(event: MessageCreated): Promise<void> {
  for (const chunk of splitMessage(buildStatusText())) {
    await event.message.answer({ text: chunk });
  }
}

/** Собирает отчёт о конфигурации. Секреты не выводим — только факт того, задано значение или нет. */
export function buildStatusText(): string {
  const settings = getSettings();
  const lines = [
    "🔧 Статус",
    "",
    `Режим: ${settings.botMode}`,
    `PROD: ${settings.prod}`,
    `Администраторов: ${settings.adminIdsSet.size}`,
    `База данных: ${settings.databaseUrl ? "подключена" : "не используется"}`,
    `Метрики: ${settings.metricsEnabled ? "включены" : "выключены"}`,
    `Сборка: ${settings.buildTag || "—"}`,
  ];
  if (settings.useWebhook) {
    lines.push(`Webhook: ${settings.webhookUrl}`);
  }
  return lines.join("\n");
}

/** Режет длинный текст на части по границам строк — разрыв строки посередине ломает форматирование. */
export function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LEN): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (const line of text.split("\n")) {
    const need = line.length + 1; // +1 за перевод строки
    if (currentLen + need > maxLen && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [line];
      currentLen = need;
    } else {
      current.push(line);
      currentLen += need;
    }
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks.length > 0 ? chunks : [""];
}
