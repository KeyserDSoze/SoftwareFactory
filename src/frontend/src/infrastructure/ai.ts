import type { AiProfile } from "../domain/types";
import type { ThinkingChoice } from "../domain/agent-roles";

export class ProviderError extends Error {
  constructor(message: string) { super(message); this.name = "ProviderError"; }
}
export function validateAiEndpoint(input: string): string {
  const url = new URL(input);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash)
    throw new ProviderError("Endpoint AI non valido: usa HTTPS, oppure HTTP solo su localhost.");
  return url.href.replace(/\/$/, "");
}
export async function aiComplete(profile: AiProfile, apiKey: string, system: string, user: string,
  signal?: AbortSignal, options?: { model?: string; thinking?: ThinkingChoice }): Promise<string> {
  const model = (options?.model ?? profile.model).trim();
  if (!model) throw new ProviderError("Configura il modello AI nelle Impostazioni.");
  const thinking = options?.thinking ?? profile.reasoningEffort;
  if (thinking !== undefined && !["automatic", "low", "medium", "high", "xhigh"].includes(thinking))
    throw new ProviderError("Livello di thinking non valido.");
  const endpoint = validateAiEndpoint(profile.baseUrl);
  const response = await fetch(endpoint + "/chat/completions", {
    method: "POST", mode: "cors", redirect: "error", signal,
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}) },
    // BookWriter-style: "automatic" omits the optional provider field.
    // Most reasoning models reject temperature together with reasoning_effort.
    body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }],
      ...(thinking && thinking !== "automatic" ? { reasoning_effort: thinking } : { temperature: 0.3 }) }),
  });
  if (!response.ok) throw new ProviderError("Provider AI: HTTP " + response.status + ". Controlla endpoint, credenziali e modello.");
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("choices" in body) || !Array.isArray(body.choices))
    throw new ProviderError("Il provider non ha restituito una risposta compatibile.");
  const text = (body.choices as Array<{ message?: { content?: unknown } }>)[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new ProviderError("Il provider ha restituito una risposta vuota.");
  return text.trim();
}

/**
 * BookWriter-style explicit model inventory. GET only, no prompt or source code.
 * Do not follow redirects with Bearer credentials and never trust model metadata.
 */
export async function discoverAiModels(profile: AiProfile, apiKey: string,
  signal?: AbortSignal): Promise<string[]> {
  const endpoint = validateAiEndpoint(profile.baseUrl);
  const host = new URL(endpoint).hostname;
  if (!apiKey && !["localhost", "127.0.0.1", "[::1]"].includes(host))
    throw new ProviderError("Senza API key è consentita la discovery soltanto su localhost.");
  let response: Response;
  try {
    response = await fetch(endpoint + "/models", {
      method: "GET", mode: "cors", redirect: "error", cache: "no-store", signal,
      headers: apiKey ? { Authorization: "Bearer " + apiKey } : {},
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    throw new ProviderError("Impossibile leggere /models: controlla URL, HTTPS e CORS.");
  }
  if (!response.ok) throw new ProviderError("Catalogo modelli: HTTP " + response.status + ".");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("data" in data) ||
      !Array.isArray(data.data) || data.data.length > 1000)
    throw new ProviderError("Catalogo /models non valido o troppo grande.");
  const models = (data.data as unknown[]).map(item =>
    item && typeof item === "object" && "id" in item ? item.id : null);
  if (models.some(v => typeof v !== "string" || !v.trim() ||
      v.length > 200 || /[\u0000-\u001f\u007f]/.test(v)))
    throw new ProviderError("Il catalogo contiene identificatori di modello non validi.");
  return [...new Set(models as string[])].slice(0, 500);
}
