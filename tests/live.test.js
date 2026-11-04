import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT_DIR, getConfig } from "../src/config.js";
import { DataStore } from "../src/dataStore.js";
import { createLlm } from "../src/llm/index.js";
import { ScriptAgent } from "../src/agent.js";

// 真实模型测试默认跳过：需要 .env 配置 API Key 且显式 RUN_LIVE=1。
//   PowerShell:  $env:RUN_LIVE=1; node --test tests/live.test.js
const enabled = process.env.RUN_LIVE === "1";
const config = getConfig();

test("live: 正常用例可完成且时长达标（需要 RUN_LIVE=1 与 API Key）", { skip: !enabled }, async () => {
  assert.ok(config.apiKey, "缺少 OPENAI_API_KEY");
  const store = new DataStore();
  const llm = createLlm("live", config);
  const agent = new ScriptAgent({ llm, store, maxSteps: config.maxSteps, maxToolCalls: config.maxToolCalls });
  const input = JSON.parse(readFileSync(join(ROOT_DIR, "examples", "inputs", "01_normal.json"), "utf8"));
  const { result } = await agent.run(input);
  assert.equal(result.status, "completed");
  assert.ok(result.estimated_total_sec <= 30);
  assert.ok(result.material_ids.length > 0);
});
