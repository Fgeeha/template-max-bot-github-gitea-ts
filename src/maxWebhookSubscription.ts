/**
 * Подписка/отписка от webhook — единственное, что не покрывает официальный
 * клиент @maxhub/max-bot-api (он поддерживает только long polling, см.
 * https://github.com/max-messenger/max-bot-api-client-ts). Авторизация и
 * формат запроса взяты из его src/core/network/api/client.ts (заголовок
 * Authorization, а не access_token в query, как ошибочно предполагалось
 * раньше) — но сам путь /subscriptions для POST/DELETE нигде в официальном
 * клиенте не задействован и не подтверждён, поэтому вызовы сделаны
 * best-effort и не считаются фатальными на месте вызова.
 */

async function call(
  token: string,
  baseUrl: string,
  method: "POST" | "DELETE",
  body?: object,
): Promise<void> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/subscriptions`, {
    method,
    headers: { Authorization: token, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`MAX API ${method} /subscriptions: ${response.status} ${text}`);
  }
}

export async function subscribeWebhook(
  token: string,
  baseUrl: string,
  url: string,
  updateTypes: string[],
  secret: string,
): Promise<void> {
  await call(token, baseUrl, "POST", { url, update_types: updateTypes, secret });
}

export async function deleteWebhookSubscription(token: string, baseUrl: string): Promise<void> {
  await call(token, baseUrl, "DELETE");
}
