import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT_DIR } from "../src/config.js";
import { DataStore } from "../src/dataStore.js";
import { MockLlm } from "../src/llm/mockLlm.js";
import { ScriptAgent } from "../src/agent.js";

const INPUT_DIR = join(ROOT_DIR, "examples", "inputs");
const store = new DataStore();

function loadInput(name) {
  return JSON.parse(readFileSync(join(INPUT_DIR, name), "utf8"));
}

function runMock(input, opts = {}) {
  const agent = new ScriptAgent({
    llm: new MockLlm(),
    store,
    maxSteps: opts.maxSteps ?? 16,
    maxToolCalls: opts.maxToolCalls ?? 16,
  });
  return agent.run(input);
}

test("01 正常生成：超时长后被压缩到目标内，输出引用 P01", async () => {
  const { result, trace } = await runMock(loadInput("01_normal.json"));
  assert.equal(result.status, "completed");
  assert.ok(result.estimated_total_sec <= 30);
  assert.ok(result.material_ids.includes("P01"));

  // 必须有"估算超时长 -> 重写 -> 再估算达标"的调整过程
  const estimates = trace.steps
    .filter((s) => s.action === "estimate_duration")
    .map((s) => s.observation.total_sec);
  assert.ok(estimates.length >= 2, "至少两次估算");
  assert.ok(estimates[0] > 30 && estimates[estimates.length - 1] <= 30, JSON.stringify(estimates));

  const writes = trace.steps.filter((s) => s.action === "write_script");
  assert.ok(writes.length >= 2, "至少重写一次脚本");
});

test("02 缺关键信息：请求补充，且不调用工具", async () => {
  const { result, trace } = await runMock(loadInput("02_missing_info.json"));
  assert.equal(result.status, "needs_input");
  assert.ok(result.missing.includes("target_duration_sec"));
  assert.equal(result.run.tool_calls, 0);
  assert.equal(trace.steps.length, 1);
});

test("03 无素材：改写查询后仍无结果，请求补充素材", async () => {
  const { result, trace } = await runMock(loadInput("03_no_material.json"));
  assert.equal(result.status, "needs_input");
  assert.ok(result.missing.includes("materials"));
  const searches = trace.steps.filter((s) => s.action === "search_materials");
  assert.ok(searches.length >= 2, "应多次改写查询");
});

test("04 工具失败：观察错误后重试并恢复完成", async () => {
  const { result, trace } = await runMock(loadInput("04_tool_failure.json"));
  assert.equal(result.status, "completed");
  const errored = trace.steps.find(
    (s) => s.observation && s.observation.ok === false && s.observation.error_type === "tool_error",
  );
  assert.ok(errored, "轨迹中应出现一次工具错误");
  // 错误之后有成功的估算
  const idx = trace.steps.indexOf(errored);
  const laterOk = trace.steps
    .slice(idx + 1)
    .some((s) => s.action === "estimate_duration" && s.observation?.ok === true);
  assert.ok(laterOk, "错误后应重试成功");
});

test("05 超时长无法满足：明确失败", async () => {
  const { result } = await runMock(loadInput("05_over_length_fail.json"));
  assert.equal(result.status, "failed");
  assert.match(result.reason, /时长/);
});

test("步数/工具调用上限：返回明确未完成状态", async () => {
  // 构造一个"永远只调工具、从不结束"的假模型，验证预算保护
  const stubbornLlm = {
    name: "stub",
    async nextAction() {
      return { action: "search_materials", args: { query: "智能台灯" }, rationale: "loop" };
    },
  };
  const agent = new ScriptAgent({
    llm: stubbornLlm,
    store,
    maxSteps: 20,
    maxToolCalls: 3,
  });
  const { result } = await agent.run(loadInput("01_normal.json"));
  assert.equal(result.status, "max_steps");
  assert.match(result.reason, /上限/);
  assert.equal(result.run.tool_calls, 3);
});

test("模型调用异常：安全终止为失败", async () => {
  const brokenLlm = {
    name: "broken",
    async nextAction() {
      throw new Error("boom");
    },
  };
  const agent = new ScriptAgent({ llm: brokenLlm, store });
  const { result } = await agent.run(loadInput("01_normal.json"));
  assert.equal(result.status, "failed");
  assert.match(result.reason, /模型调用失败/);
});

test("所有示例输入均可被 Mock 无异常跑完", async () => {
  const files = readdirSync(INPUT_DIR).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 5);
  for (const f of files) {
    const { result } = await runMock(JSON.parse(readFileSync(join(INPUT_DIR, f), "utf8")));
    assert.ok(result.status, `${f} 应产出状态`);
  }
});
