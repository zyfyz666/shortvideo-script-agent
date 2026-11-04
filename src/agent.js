import { ToolBox } from "./tools.js";

const TERMINAL_ACTIONS = new Set(["request_info", "finish"]);

/** 把工具返回结果压缩成一行摘要，写入 trace，便于评审快速浏览。 */
export function summarizeObservation(action, obs) {
  if (!obs) return "(空)";
  if (obs.ok === false) return `ERROR ${obs.error_type || ""}: ${obs.error}`;
  switch (action) {
    case "search_materials":
      return `count=${obs.count}${
        obs.count ? " :: " + obs.materials.map((m) => `${m.id}:${(m.facts || []).join("；")}`).join(" | ") : ""
      }`;
    case "write_script":
      return `segments=${obs.segment_count}, narration_chars=${obs.narration_chars}, material_ids=[${(obs.material_ids || []).join(",")}]`;
    case "estimate_duration":
      return `total_sec=${obs.total_sec}, target_sec=${obs.target_sec}, within_target=${obs.within_target}`;
    case "check_rules":
      return `passed=${obs.passed}, violations=${(obs.violations || []).length}`;
    default:
      return JSON.stringify(obs).slice(0, 200);
  }
}

export class ScriptAgent {
  /**
   * @param {object} opts
   * @param {{nextAction:Function,name:string}} opts.llm
   * @param {import('./dataStore.js').DataStore} opts.store
   * @param {number} [opts.maxSteps]
   * @param {number} [opts.maxToolCalls]
   */
  constructor({ llm, store, maxSteps = 16, maxToolCalls = 16 }) {
    this.llm = llm;
    this.store = store;
    this.maxSteps = maxSteps;
    this.maxToolCalls = maxToolCalls;
  }

  /**
   * 运行一次 ReAct 决策循环。
   * @param {object} input 用户输入
   * @param {object} [opts]
   * @param {Record<string,number>} [opts.injectFailures] 工具故障注入
   * @returns {Promise<object>} { result, trace }
   */
  async run(input, { injectFailures = {} } = {}) {
    const failures = { ...(input.inject_failures || {}), ...injectFailures };
    const toolbox = new ToolBox(this.store, { failures });
    toolbox.currentTarget = input.target_duration_sec ?? null;

    const state = {}; // 供 Mock 使用的跨步状态
    const history = [];
    let terminal = null;

    for (let step = 1; step <= this.maxSteps; step++) {
      const workspace = {
        materials: toolbox.materials,
        draft: toolbox.currentDraft,
        lastEstimate: toolbox.lastEstimate,
        lastCheck: toolbox.lastCheck,
        target: toolbox.currentTarget,
        step,
        maxSteps: this.maxSteps,
        toolCalls: toolbox.calls,
        maxToolCalls: this.maxToolCalls,
      };

      let action;
      try {
        action = await this.llm.nextAction({ input, state, history, workspace });
      } catch (err) {
        terminal = {
          action: "finish",
          args: { status: "failed", reason: `模型调用失败：${err.message}` },
          rationale: "LLM 调用异常，安全终止",
          _llm_error: true,
        };
        history.push({
          step,
          action: "(llm_error)",
          args: {},
          rationale: terminal.rationale,
          observation: { ok: false, error: err.message, error_type: "llm_error" },
          observation_summary: `ERROR llm_error: ${err.message}`,
        });
        break;
      }

      if (!action || !action.action) {
        terminal = {
          action: "finish",
          args: { status: "failed", reason: "模型未产出有效动作" },
          rationale: "无有效动作，安全终止",
        };
        break;
      }

      if (TERMINAL_ACTIONS.has(action.action)) {
        terminal = action;
        history.push({
          step,
          action: action.action,
          args: action.args || {},
          rationale: action.rationale || "",
          observation: null,
          observation_summary: "(终止动作，不调用工具)",
        });
        break;
      }

      if (toolbox.calls >= this.maxToolCalls) {
        history.push({
          step,
          action: action.action,
          args: action.args || {},
          rationale: action.rationale || "",
          observation: { ok: false, error: "达到工具调用次数上限", error_type: "budget" },
          observation_summary: "ERROR budget: 达到工具调用次数上限",
        });
        terminal = {
          action: "finish",
          args: {
            status: "max_steps",
            reason: `达到工具调用次数上限(${this.maxToolCalls})，任务未完成`,
          },
          rationale: "预算耗尽，返回未完成状态",
        };
        break;
      }

      let observation;
      try {
        observation = toolbox.call(action.action, action.args || {});
      } catch (err) {
        observation = {
          ok: false,
          error: err.message,
          error_type: err.name === "ToolError" ? "tool_error" : "runtime_error",
        };
      }
      history.push({
        step,
        action: action.action,
        args: action.args || {},
        rationale: action.rationale || "",
        observation,
        observation_summary: summarizeObservation(action.action, observation),
      });
    }

    if (!terminal) {
      terminal = {
        action: "finish",
        args: { status: "max_steps", reason: `达到最大步数上限(${this.maxSteps})，任务未完成` },
        rationale: "步数耗尽，返回未完成状态",
      };
    }

    const result = this._buildResult(input, terminal, toolbox);
    const trace = {
      case_id: input.case_id || null,
      llm: this.llm.name,
      input,
      max_steps: this.maxSteps,
      max_tool_calls: this.maxToolCalls,
      steps: history,
      result,
    };
    return { result, trace };
  }

  _buildResult(input, terminal, toolbox) {
    const status = terminal.args?.status || (terminal.action === "request_info" ? "needs_input" : "failed");
    const draft = toolbox.currentDraft;
    const est = toolbox.lastEstimate;
    const check = toolbox.lastCheck;

    const risks = [];
    if (check && !check.passed) {
      for (const v of check.violations) risks.push(`${v.rule_id}: ${v.message}`);
    }
    if (draft && !draft.segments.some((s) => (s.material_ids || []).length)) {
      risks.push("脚本未引用任何素材 ID，存在无事实依据风险");
    }

    const materialIds = draft
      ? [...new Set(draft.segments.flatMap((s) => s.material_ids || []))]
      : [];

    return {
      case_id: input.case_id || null,
      status,
      reason: terminal.args?.reason || terminal.args?.question || "",
      missing: terminal.args?.missing || null,
      title: draft?.title || null,
      target_duration_sec: input.target_duration_sec ?? null,
      estimated_total_sec: est?.total_sec ?? null,
      segments: draft?.segments || [],
      material_ids: materialIds,
      risks,
      run: {
        llm: this.llm.name,
        steps: toolSteps(toolbox),
        tool_calls: toolbox.calls,
        max_steps: this.maxSteps,
        max_tool_calls: this.maxToolCalls,
        finished_action: terminal.action,
      },
    };
  }
}

function toolSteps(toolbox) {
  return toolbox.callLog.length;
}
