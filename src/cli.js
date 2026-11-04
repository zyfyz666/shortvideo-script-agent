import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getConfig } from "./config.js";
import { DataStore } from "./dataStore.js";
import { createLlm } from "./llm/index.js";
import { ScriptAgent } from "./agent.js";

function parseArgs(argv) {
  const args = { _: [], fail: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fail") {
      args.fail.push(argv[++i]);
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      args[key] = val;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function parseFailures(list) {
  const failures = {};
  for (const item of list) {
    const [name, n] = String(item).split("=");
    failures[name] = Number.parseInt(n ?? "1", 10);
  }
  return failures;
}

function readInput(args) {
  if (args.input) {
    return JSON.parse(readFileSync(args.input, "utf8"));
  }
  // 无 --input 时从 stdin 读取
  try {
    const raw = readFileSync(0, "utf8").trim();
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return {
    case_id: "inline_default",
    topic: "智能台灯",
    audience: "大学生",
    platform: "抖音",
    target_duration_sec: 30,
    style: "轻松种草",
  };
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

function printSummary(trace) {
  const { result, steps } = trace;
  const lines = [];
  lines.push("================ 运行摘要 ================");
  lines.push(`用例: ${result.case_id}  LLM: ${trace.llm}  状态: ${result.status}`);
  lines.push(
    `步数/工具调用: ${result.run.steps}/${result.run.tool_calls} (上限 ${result.run.max_steps}/${result.run.max_tool_calls})`,
  );
  lines.push("");
  lines.push("--- 决策轨迹 (动作 -> 观察) ---");
  for (const s of steps) {
    lines.push(`step${s.step} ${s.action} ${JSON.stringify(s.args)}`);
    lines.push(`      rationale: ${s.rationale}`);
    lines.push(`      observe  : ${s.observation_summary}`);
  }
  lines.push("");
  lines.push("--- 交付结果 ---");
  if (result.title) lines.push(`标题: ${result.title}`);
  lines.push(`预计总时长: ${result.estimated_total_sec ?? "N/A"}s / 目标 ${result.target_duration_sec ?? "N/A"}s`);
  lines.push(`素材来源 ID: [${(result.material_ids || []).join(", ")}]`);
  if (result.missing) lines.push(`缺少信息: ${result.missing.join(", ")}`);
  if (result.reason) lines.push(`说明: ${result.reason}`);
  if (result.segments?.length) {
    lines.push("分镜:");
    for (const seg of result.segments) {
      lines.push(`  #${seg.shot} [${(seg.material_ids || []).join(",") || "-"}] ${seg.narration}`);
    }
  }
  if (result.risks?.length) lines.push(`风险: ${result.risks.join(" ; ")}`);
  lines.push("==========================================");
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "run";
  const args = parseArgs(command === "run" ? argv.slice(1) : argv);

  const config = getConfig({
    maxSteps: args["max-steps"] ? Number(args["max-steps"]) : undefined,
    maxToolCalls: args["max-tool-calls"] ? Number(args["max-tool-calls"]) : undefined,
    baseUrl: args["base-url"],
    apiKey: args["api-key"],
    model: args.model,
  });

  const llmKind = args.llm || "mock";
  const llm = createLlm(llmKind, config);
  const store = new DataStore();
  const agent = new ScriptAgent({
    llm,
    store,
    maxSteps: config.maxSteps,
    maxToolCalls: config.maxToolCalls,
  });

  const input = readInput(args);
  const injectFailures = parseFailures(args.fail);

  const { result, trace } = await agent.run(input, { injectFailures });

  if (args["trace"] || args["save-trace"]) writeJson(args["trace"] || args["save-trace"], trace);
  if (args["out"] || args["save-output"]) writeJson(args["out"] || args["save-output"], result);

  if (args.json) {
    process.stdout.write(JSON.stringify({ result, trace }, null, 2) + "\n");
  } else {
    process.stdout.write(printSummary(trace) + "\n");
  }

  // 退出码：完成=0，其余=1（便于脚本/测试判断）
  process.exitCode = result.status === "completed" ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`运行失败: ${err.stack || err.message}\n`);
  process.exitCode = 2;
});
