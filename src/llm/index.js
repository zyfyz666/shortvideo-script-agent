import { MockLlm } from "./mockLlm.js";
import { OpenAiLlm } from "./openaiLlm.js";

export { MockLlm, OpenAiLlm };

/**
 * 根据名称创建 LLM。
 * @param {"mock"|"live"} kind
 * @param {object} config
 */
export function createLlm(kind, config = {}) {
  if (kind === "live") {
    return new OpenAiLlm({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      timeoutMs: config.timeoutMs,
    });
  }
  return new MockLlm();
}
