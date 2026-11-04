/**
 * 工具层：素材检索 / 时长估算 / 规则检查 / 脚本写入。
 * 这些是 Agent 可调用的"业务工具"，实现为本地纯函数 + 有状态工作区。
 */

export const DEFAULT_DURATION_OPTIONS = {
  charsPerSecond: 4.2,
  sceneOverheadSec: 0.5,
};

/** 工具调用异常：抛出后由 Agent 转成 observation.error 反馈给模型。 */
export class ToolError extends Error {
  constructor(tool, message) {
    super(message);
    this.name = "ToolError";
    this.tool = tool;
  }
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function segmentText(seg) {
  return String(seg?.narration || seg?.subtitle || "");
}

/**
 * 时长估算：按语速将每段旁白文本折算为秒数，并叠加固定分镜开销。
 * @returns {{total_sec:number, segments:Array<{shot:number,duration_sec:number}>}}
 */
export function estimateDuration(segments, options = {}) {
  const { charsPerSecond, sceneOverheadSec } = {
    ...DEFAULT_DURATION_OPTIONS,
    ...options,
  };
  let total = 0;
  const detail = [];
  for (const seg of segments) {
    const chars = segmentText(seg).replace(/\s+/g, "").length;
    const sec = chars / charsPerSecond + sceneOverheadSec;
    total += sec;
    detail.push({ shot: seg.shot ?? detail.length + 1, chars, duration_sec: round1(sec) });
  }
  return { total_sec: round1(total), segments: detail };
}

/**
 * 规则检查。返回违反项列表；空列表表示通过。
 * @param {Array} segments
 * @param {object} draft  含 target_duration_sec
 * @param {import('./dataStore.js').DataStore} store
 * @param {number} totalSec 已估算的时长
 */
export function checkRules(segments, draft, store, totalSec) {
  const violations = [];
  const target = Number(draft.target_duration_sec);

  if (Number.isFinite(target) && totalSec > target) {
    violations.push({
      rule_id: "R1",
      shot: null,
      message: `预计总时长 ${totalSec}s 超过目标 ${target}s`,
    });
  }

  const effectRe = new RegExp((store.effectPatterns || []).join("|") || "(?!)");
  const claimKw = store.claimKeywords || [];

  segments.forEach((seg, i) => {
    const shot = seg.shot ?? i + 1;
    const text = segmentText(seg);
    const ids = Array.isArray(seg.material_ids) ? seg.material_ids : [];
    const hasClaim =
      /[0-9]/.test(text) || claimKw.some((kw) => kw && text.includes(kw));

    if (hasClaim && ids.length === 0) {
      violations.push({
        rule_id: "R2",
        shot,
        message: `第 ${shot} 分镜含产品事实但未引用任何素材 ID`,
      });
    }

    for (const id of ids) {
      if (!store.getMaterial(id)) {
        violations.push({
          rule_id: "R2",
          shot,
          message: `第 ${shot} 分镜引用了不存在的素材 ID：${id}`,
        });
      }
    }

    if (effectRe.test(text)) {
      const facts = ids
        .map((id) => store.getMaterial(id))
        .filter(Boolean)
        .flatMap((m) => m.facts || [])
        .join(" ");
      const token = (text.match(effectRe) || [""])[0];
      if (!token || !facts.includes(token)) {
        violations.push({
          rule_id: "R3",
          shot,
          message: `第 ${shot} 分镜出现效果表述"${token || "效果承诺"}"但被引用素材无对应事实，疑似无依据宣传`,
        });
      }
    }
  });

  const forbidden = store.rules.find((r) => r.type === "forbidden_words");
  if (forbidden) {
    segments.forEach((seg, i) => {
      const shot = seg.shot ?? i + 1;
      const text = segmentText(seg);
      for (const w of forbidden.words || []) {
        if (w && text.includes(w)) {
          violations.push({
            rule_id: forbidden.id,
            shot,
            message: `第 ${shot} 分镜出现绝对化用语："${w}"`,
          });
        }
      }
    });
  }

  return violations;
}

/**
 * Agent 工作区：持有当前脚本草稿与最近一次估算/检查结果，
 * 使 estimate_duration / check_rules 能读取"当前脚本"。
 */
export class ToolBox {
  /**
   * @param {import('./dataStore.js').DataStore} store
   * @param {object} opts
   * @param {Record<string, number>} [opts.failures] 注入临时故障：{工具名: 失败次数}
   * @param {object} [opts.durationOptions]
   */
  constructor(store, { failures = {}, durationOptions = {} } = {}) {
    this.store = store;
    this.failures = { ...failures };
    this.durationOptions = { ...DEFAULT_DURATION_OPTIONS, ...durationOptions };
    this.currentDraft = null;
    this.currentTarget = null;
    this.materials = null;
    this.lastEstimate = null;
    this.lastCheck = null;
    this.calls = 0;
    this.callLog = [];
  }

  _maybeFail(name) {
    const remaining = this.failures[name] || 0;
    if (remaining > 0) {
      this.failures[name] = remaining - 1;
      throw new ToolError(
        name,
        `工具 ${name} 临时故障（注入失败，剩余 ${remaining - 1} 次）`,
      );
    }
  }

  /** 执行一个工具动作。 */
  call(name, args = {}) {
    this.calls++;
    this._maybeFail(name);
    let result;
    switch (name) {
      case "search_materials":
        result = this._searchMaterials(args);
        break;
      case "write_script":
        result = this._writeScript(args);
        break;
      case "estimate_duration":
        result = this._estimateDuration();
        break;
      case "check_rules":
        result = this._checkRules();
        break;
      default:
        throw new ToolError(name, `未知工具：${name}`);
    }
    this.callLog.push({ name, args, result });
    return result;
  }

  _searchMaterials({ query } = {}) {
    const { count, materials } = this.store.search(query);
    if (count > 0) this.materials = materials;
    return {
      ok: true,
      tool: "search_materials",
      query: query ?? "",
      count,
      materials: materials.map((m) => ({
        id: m.id,
        title: m.title,
        facts: m.facts,
        tags: m.tags,
      })),
    };
  }

  _writeScript({ title, segments, notes } = {}) {
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new ToolError(
        "write_script",
        "segments 必须是非空数组，元素形如 {shot, visual, narration, subtitle?, material_ids?}",
      );
    }
    const normalized = segments.map((s, i) => ({
      shot: s.shot ?? i + 1,
      visual: String(s.visual ?? ""),
      narration: String(s.narration ?? ""),
      subtitle: String(s.subtitle ?? s.narration ?? ""),
      material_ids: Array.isArray(s.material_ids) ? s.material_ids : [],
    }));
    this.currentDraft = {
      title: String(title ?? this.currentDraft?.title ?? ""),
      segments: normalized,
      notes: String(notes ?? ""),
    };
    const narrationChars = normalized
      .map((s) => s.narration.replace(/\s+/g, "").length)
      .reduce((a, b) => a + b, 0);
    return {
      ok: true,
      tool: "write_script",
      segment_count: normalized.length,
      narration_chars: narrationChars,
      material_ids: [...new Set(normalized.flatMap((s) => s.material_ids))],
    };
  }

  _estimateDuration() {
    if (!this.currentDraft) {
      throw new ToolError("estimate_duration", "当前没有脚本草稿，请先调用 write_script");
    }
    const est = estimateDuration(this.currentDraft.segments, this.durationOptions);
    const target = Number(this.currentTarget);
    const within = !Number.isFinite(target) || est.total_sec <= target;
    this.lastEstimate = { ...est, target_sec: this.currentTarget ?? null, within_target: within };
    return {
      ok: true,
      tool: "estimate_duration",
      total_sec: est.total_sec,
      target_sec: this.currentTarget ?? null,
      within_target: within,
      chars_per_second: this.durationOptions.charsPerSecond,
      segments: est.segments,
    };
  }

  _checkRules() {
    if (!this.currentDraft) {
      throw new ToolError("check_rules", "当前没有脚本草稿，请先调用 write_script");
    }
    const est = estimateDuration(this.currentDraft.segments, this.durationOptions);
    const violations = checkRules(
      this.currentDraft.segments,
      { ...this.currentDraft, target_duration_sec: this.currentTarget },
      this.store,
      est.total_sec,
    );
    this.lastCheck = { passed: violations.length === 0, violations, total_sec: est.total_sec };
    return {
      ok: true,
      tool: "check_rules",
      passed: violations.length === 0,
      total_sec: est.total_sec,
      violations,
    };
  }
}
