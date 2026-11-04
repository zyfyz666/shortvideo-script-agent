/**
 * 离线 Mock 决策器（零依赖、确定性）。
 *
 * 重要边界：Mock 只用于验证"动作 → 工具 → 观察 → 调整"的流程是否闭环，
 * 不代表真实模型的语义决策质量。真实效果请用 --llm live 跑真实模型。
 *
 * 它实现了一个状态机式 ReAct 策略：每一步根据上一步工具返回的观察结果，
 * 决定下一步动作（检索 / 重写查询 / 撰写脚本 / 估算 / 修正 / 规则检查 / 结束）。
 */

export const REQUIRED_FIELDS = ["topic", "platform", "target_duration_sec"];
const MAX_SEARCH_TRIES = 3;
const MAX_REVISIONS = 2;
const MAX_RULE_FIXES = 1;
const MAX_TOOL_RETRIES = 1;

function A(action, args, rationale) {
  return { action, args, rationale };
}

/** 依据素材事实拼装脚本草稿；variant 控制冗长程度。 */
export function buildDraft(input, materials, variant = "verbose") {
  const topic = input.topic || "产品";
  const audience = input.audience || "你";
  const style = input.style ? `整体风格：${style_note(input.style)}` : "";

  const FILLER = {
    verbose: {
      hook: `大家好，今天给大家种草一款超实用的${topic}，${audience}一定要看。`,
      fact: (f) => `它${f}，这一点真的很加分，用起来特别省心。`,
      cta: `喜欢的话就点击下方链接，把它带回家吧。`,
    },
    concise: {
      hook: `${audience}必备的${topic}来啦。`,
      fact: (f) => `它${f}，用起来很省心。`,
      cta: `喜欢就点击下方链接带回家吧。`,
    },
    minimal: {
      hook: null,
      fact: (f) => `${f}。`,
      cta: `点击下方链接。`,
    },
  };
  const F = FILLER[variant] || FILLER.verbose;

  const segments = [];
  let shot = 1;

  if (F.hook) {
    segments.push({
      shot: shot++,
      visual: `主播出镜，手持${topic}`,
      narration: F.hook,
      material_ids: [],
    });
  }

  const picks = materials.slice(0, 3);
  for (const m of picks) {
    for (const fact of m.facts || []) {
      segments.push({
        shot: shot++,
        visual: `展示${m.title}`,
        narration: F.fact(fact),
        material_ids: [m.id],
      });
    }
  }

  segments.push({
    shot: shot++,
    visual: "优惠信息 / 引导关注",
    narration: F.cta,
    material_ids: [],
  });

  return {
    title: `${topic}｜${input.platform || ""}${input.target_duration_sec ? input.target_duration_sec + "秒" : ""}短视频脚本`.trim(),
    segments,
    notes: style,
  };
}

function style_note(style) {
  return String(style);
}

/** 重写检索查询：逐步泛化/补充，模拟"改写查询重试"。 */
function rewriteQuery(topic, attempt) {
  if (attempt === 2) return `${topic} 产品卖点`;
  if (attempt === 3) return `${topic} 功能 参数`;
  return topic;
}

/**
 * 主决策入口。
 * @param {object} ctx
 * @param {object} ctx.input   用户输入
 * @param {object} ctx.state   跨步可变状态
 * @param {Array}  ctx.history 已完成步骤 [{step,action,args,observation,...}]
 * @returns {{action:string,args:object,rationale:string}}
 */
export function decide({ input, state, history }) {
  const last = history.length ? history[history.length - 1] : null;

  // —— 通用容错：工具报错时先重试一次，仍失败则明确失败 ——
  if (
    last &&
    last.observation &&
    last.observation.ok === false &&
    last.observation.error_type === "tool_error"
  ) {
    state.retries = state.retries || {};
    const used = state.retries[last.action] || 0;
    if (used < MAX_TOOL_RETRIES) {
      state.retries[last.action] = used + 1;
      return A(last.action, last.args, `工具 ${last.action} 报错，原样重试一次以确认是否为瞬时故障`);
    }
    return A(
      "finish",
      {
        status: "failed",
        reason: `工具 ${last.action} 连续失败，无法继续执行`,
      },
      "工具重试后仍失败，明确终止并返回未完成状态",
    );
  }

  switch (state.phase) {
    case undefined: {
      const missing = REQUIRED_FIELDS.filter(
        (k) => input[k] === undefined || input[k] === null || input[k] === "",
      );
      if (missing.length) {
        state.phase = "blocked";
        return A(
          "request_info",
          {
            missing,
            question: `生成脚本前还需要以下关键信息：${missing.join("、")}。请补充后重试。`,
          },
          "缺少平台/目标时长等关键信息，先请求用户补充，避免凭空假设",
        );
      }
      state.phase = "search";
      state.searchTries = 1;
      return A(
        "search_materials",
        { query: input.topic },
        "先检索与主题相关的产品素材，作为事实依据",
      );
    }

    case "search": {
      const obs = last?.observation || {};
      if (obs.ok && obs.count > 0) {
        state.materials = obs.materials;
        state.phase = "after_write";
        return A(
          "write_script",
          buildDraft(input, state.materials, "verbose"),
          `检索到 ${obs.count} 条素材，据此撰写初稿`,
        );
      }
      if (state.searchTries < MAX_SEARCH_TRIES) {
        state.searchTries += 1;
        return A(
          "search_materials",
          { query: rewriteQuery(input.topic, state.searchTries) },
          `第 ${state.searchTries - 1} 次检索无结果，改写查询后重试`,
        );
      }
      state.phase = "blocked";
      return A(
        "request_info",
        {
          missing: ["materials"],
          question: "未检索到与主题相关的产品素材，请补充素材后重试。",
        },
        "多次改写查询仍无素材，无法生成有事实依据的脚本，请求补充素材",
      );
    }

    case "after_write": {
      state.phase = "after_estimate";
      return A("estimate_duration", {}, "初稿完成，先估算时长是否满足限制");
    }

    case "after_estimate": {
      const obs = last?.observation || {};
      if (obs.within_target) {
        state.phase = "after_check";
        return A("check_rules", {}, `时长 ${obs.total_sec}s 未超目标，继续做规则检查`);
      }
      if ((state.revisions || 0) < MAX_REVISIONS) {
        state.revisions = (state.revisions || 0) + 1;
        const variant = state.revisions === 1 ? "concise" : "minimal";
        state.phase = "after_write";
        return A(
          "write_script",
          buildDraft(input, state.materials, variant),
          `时长 ${obs.total_sec}s 超过目标 ${obs.target_sec}s，压缩脚本后重新估算`,
        );
      }
      return A(
        "finish",
        {
          status: "failed",
          reason: `已修正 ${state.revisions} 次，预计时长仍超过目标，当前素材无法在目标时长内完成`,
        },
        "多次压缩后仍超时长，无法满足硬性时长要求，明确失败",
      );
    }

    case "after_check": {
      const obs = last?.observation || {};
      if (obs.passed) {
        return A(
          "finish",
          { status: "completed", reason: "时长与品牌规则检查均通过" },
          "所有检查通过，输出最终脚本",
        );
      }
      if ((state.ruleFixes || 0) < MAX_RULE_FIXES) {
        state.ruleFixes = (state.ruleFixes || 0) + 1;
        state.phase = "after_write";
        return A(
          "write_script",
          buildDraft(input, state.materials, "concise"),
          `规则检查未通过（${(obs.violations || []).length} 项），调整脚本后重新检查`,
        );
      }
      return A(
        "finish",
        {
          status: "failed",
          reason: `调整后仍存在无法自动修复的规则问题：${(obs.violations || [])
            .map((v) => v.rule_id)
            .join(",")}`,
        },
        "规则问题无法自动修复，明确失败并说明原因",
      );
    }

    default:
      return A(
        "finish",
        { status: "failed", reason: `未知状态：${state.phase}` },
        "状态异常，安全终止",
      );
  }
}

export class MockLlm {
  constructor() {
    this.name = "mock";
  }

  /** 与真实 LLM 相同的决策接口。 */
  async nextAction(ctx) {
    return decide(ctx);
  }
}
