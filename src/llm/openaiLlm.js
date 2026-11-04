/**
 * 真实模型接入（OpenAI 兼容 /chat/completions）。
 * 默认对接 CSU Chat 网关（provider "csu"），可通过环境变量替换。
 * 仅依赖 Node 内置 fetch，无第三方 SDK。
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt, retryAfterHeader) {
  if (retryAfterHeader) {
    const secs = Number(retryAfterHeader);
    if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 30000);
  }
  const base = 1000 * 2 ** attempt;
  return Math.min(base + Math.random() * 500, 30000);
}

export const TOOL_SPEC = `可用动作（每次只能选择一个）：
1. search_materials  args:{query:string}
   检索产品素材，返回素材 id、标题、事实。无结果时 count=0。
2. write_script  args:{title:string, segments:[{shot:number, visual:string, narration:string, subtitle?:string, material_ids?:string[]}], notes?:string}
   写入或替换"当前脚本草稿"。
3. estimate_duration  args:{}  估算"当前脚本"总时长，返回 total_sec / within_target。
4. check_rules  args:{}  对"当前脚本"做时长与品牌规则检查，返回 passed / violations。
5. request_info  args:{missing:string[], question:string}  关键信息不足时请求用户补充（终止动作）。
6. finish  args:{status:"completed"|"failed", reason:string}  结束任务（终止动作）。`;

const SYSTEM_PROMPT = `你是一个"短视频脚本 Agent"。你的任务：基于检索到的产品素材，生成有事实依据、满足时长限制、可编辑的短视频脚本。

你必须在每一步只输出一个 JSON 对象，形如：
{"action":"<动作名>","args":{...},"rationale":"<一句话说明为什么做这个动作>"}

规则约束：
- 若用户输入缺少关键字段（topic / platform / target_duration_sec 任一为空），第一步必须 request_info，列出缺失字段，不要凭空假设。
- 必须先检索素材，脚本中的每个产品事实都必须来自某条素材，并在对应分镜的 material_ids 中标注素材 id。
- 严禁编造素材中没有的产品事实或效果数据（例如"效率提升 80%"）。
- 目标时长是硬约束：估算或规则检查不通过时，应压缩/调整脚本后重新检查；若无法满足，用 finish 明确失败并说明。
- 检索无结果时可改写查询重试；仍无结果则 request_info 请求补充素材。
- 不要输出除该 JSON 之外的任何文字。`;

function summarizeMaterials(materials) {
  if (!materials) return "（尚未检索）";
  return materials
    .map((m) => `${m.id}:${(m.facts || []).join("；")}`)
    .join(" | ");
}

function buildUserPrompt(ctx) {
  const { input, workspace, history } = ctx;
  const recent = history.slice(-8);
  const lines = [];
  lines.push("## 用户输入");
  lines.push(JSON.stringify(input, null, 2));
  lines.push("");
  lines.push("## 当前工作区");
  lines.push(`目标时长(秒): ${workspace.target ?? "(未提供)"}`);
  lines.push(`已用步数: ${workspace.step}/${workspace.maxSteps}，已用工具调用: ${workspace.toolCalls}/${workspace.maxToolCalls}`);
  lines.push(`已检索素材: ${summarizeMaterials(workspace.materials)}`);
  lines.push(
    `最近一次时长估算: ${workspace.lastEstimate ? JSON.stringify({ total_sec: workspace.lastEstimate.total_sec, within_target: workspace.lastEstimate.within_target }) : "无"}`,
  );
  lines.push(
    `最近一次规则检查: ${workspace.lastCheck ? JSON.stringify({ passed: workspace.lastCheck.passed, violations: workspace.lastCheck.violations }) : "无"}`,
  );
  lines.push(
    `当前脚本草稿: ${workspace.draft ? JSON.stringify(workspace.draft) : "无"}`,
  );
  lines.push("");
  lines.push("## 已完成步骤（动作 + 返回摘要）");
  if (!recent.length) lines.push("（无）");
  for (const h of recent) {
    lines.push(`- step${h.step} ${h.action} ${JSON.stringify(h.args)} -> ${h.observation_summary}`);
  }
  lines.push("");
  lines.push("请输出下一步动作的 JSON。");
  return lines.join("\n");
}

function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export class OpenAiLlm {
  constructor({ baseUrl, apiKey, model, timeoutMs = 120000 } = {}) {
    if (!apiKey) {
      throw new Error("缺少 API Key：请在 .env 中设置 OPENAI_API_KEY，或改用 --llm mock");
    }
    this.baseUrl = String(baseUrl || "").replace(/\/$/, "");
    this.apiKey = apiKey;
    this.model = model || "DeepSeek";
    this.timeoutMs = timeoutMs;
    this.name = "live";
  }

  async _chat(messages, { retries = 4 } = {}) {
    const url = `${this.baseUrl}/chat/completions`;
    const body = {
      model: this.model,
      messages,
      temperature: 0,
      response_format: { type: "json_object" },
    };

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        };
        let res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (res.status === 400 && body.response_format) {
          // 部分网关不支持 response_format，去掉后重试一次
          delete body.response_format;
          res = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        }
        if (res.status === 429 || res.status >= 500) {
          const detail = await res.text().catch(() => "");
          const waitMs = backoffMs(attempt, res.headers.get("retry-after"));
          if (attempt < retries) {
            process.stderr.write(`[openaiLlm] ${res.status}，${waitMs}ms 后重试 (${attempt + 1}/${retries})\n`);
            await sleep(waitMs);
            lastErr = new Error(`HTTP ${res.status} ${res.statusText} ${detail.slice(0, 200)}`);
            continue;
          }
          throw new Error(`HTTP ${res.status} ${res.statusText} ${detail.slice(0, 300)}`);
        }
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status} ${res.statusText} ${detail.slice(0, 300)}`);
        }
        const data = await res.json();
        const msg = data?.choices?.[0]?.message || {};
        return msg.content ?? msg.reasoning ?? "";
      } catch (err) {
        lastErr = err;
        if (attempt < retries && /aborted|ECONNRESET|ETIMEDOUT|fetch failed/i.test(err.message)) {
          await sleep(backoffMs(attempt, null));
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new Error("模型调用失败");
  }

  async nextAction(ctx) {
    const messages = [
      { role: "system", content: `${SYSTEM_PROMPT}\n\n${TOOL_SPEC}` },
      { role: "user", content: buildUserPrompt(ctx) },
    ];
    let raw = await this._chat(messages);
    let parsed = extractJson(raw);
    if (!parsed || !parsed.action) {
      // 再给模型一次机会，明确要求只回 JSON
      messages.push({ role: "assistant", content: String(raw).slice(0, 2000) });
      messages.push({
        role: "user",
        content: '你上一条回复不是合法 JSON。请只输出一个 JSON 对象：{"action":"...","args":{...},"rationale":"..."}',
      });
      raw = await this._chat(messages);
      parsed = extractJson(raw);
    }
    if (!parsed || !parsed.action) {
      throw new Error(`模型未返回可解析的动作 JSON：${String(raw).slice(0, 300)}`);
    }
    return {
      action: parsed.action,
      args: parsed.args || {},
      rationale: parsed.rationale || "",
    };
  }
}
