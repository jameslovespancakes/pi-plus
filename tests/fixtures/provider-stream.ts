import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";

export const model: Model<"openai-completions"> = {
  id: "test-model", name: "Test", api: "openai-completions", provider: "test-provider",
  baseUrl: "https://invalid.test", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
export function message(error?: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: error ? [] : [{ type: "text", text: "ok" }], stopReason: error ? "error" : "stop",
    errorMessage: error, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...overrides };
}
export function response(result: AssistantMessage, middle: AssistantMessageEvent[] = []) {
  const events = createAssistantMessageEventStream();
  events.push({ type: "start", partial: { ...result, content: [] } });
  for (const event of middle) events.push(event);
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    events.push({ type: "error", reason: result.stopReason, error: result });
  } else events.push({ type: "done", reason: result.stopReason as "stop", message: result });
  events.end();
  return events;
}
