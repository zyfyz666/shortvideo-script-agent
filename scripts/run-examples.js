/**
 * 批量运行 examples/inputs 下的用例，落盘 trace 与 output。
 *   node scripts/run-examples.js            # 用 Mock 跑（默认）
 *   node scripts/run-examples.js --live     # 用真实模型跑
 *   node scripts/run-examples.js --check    # 额外做结果断言（CI 用）
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfig, ROOT_DIR } from "../src/config.js";
import { DataStore } from "../src/dataStore.js";
import { createLlm } from "../src/llm/index.js";
import { ScriptAgent } from "../src/agent.js";

const INPUT_DIR = join(ROOT_DIR, "examples", "inputs");
const TRACE_DIR = join(ROOT_DIR, "examples", "traces");
const OUTPUT_DIR = join(ROOT_DIR, "examples", "outputs");

const EXPECT = {
  "01_normal": (r) => r.status === "completed" && r.estimated_total_sec <= 30 && r.material_ids.includes("P01"),
  "02_missing_info": (r) => r.status === "needs_input" && (r.missing || []).includes("target_duration_sec"),
  "03_no_material": (r) => r.status === "needs_input" && (r.missing || []).includes("materials"),
  "04_tool_failure": (r) => r.status === "completed",
  "05_over_length_fail": (r) => r.status === "failed",
};

async function main() {
  const live = process.argv.includes("--live");
  const check = process.argv.includes("--check");
  const config = getConfig();
  const llm = createLlm(live ? "live" : "mock", config);
  const store = new DataStore();
  const agent = new ScriptAgent({ llm, store, maxSteps: config.maxSteps, maxToolCalls: config.maxToolCalls });

  mkdirSync(TRACE_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const files = readdirSync(INPUT_DIR).filter((f) => f.endsWith(".json")).sort();
  const suffix = live ? "live" : "mock";
  let allOk = true;

  const rows = [];
  for (const file of files) {
    const input = JSON.parse(readFileSync(join(INPUT_DIR, file), "utf8"));
    const { result, trace } = await agent.run(input);
    const base = file.replace(/\.json$/, "");
    writeFileSync(join(TRACE_DIR, `${base}_${suffix}.json`), JSON.stringify(trace, null, 2), "utf8");
    writeFileSync(join(OUTPUT_DIR, `${base}_${suffix}.json`), JSON.stringify(result, null, 2), "utf8");

    let ok = "-";
    if (check && EXPECT[base]) {
      ok = EXPECT[base](result) ? "PASS" : "FAIL";
      if (ok === "FAIL") allOk = false;
    }
    rows.push({
      case: base,
      status: result.status,
      seconds: result.estimated_total_sec ?? "-",
      target: result.target_duration_sec ?? "-",
      materials: (result.material_ids || []).join(",") || "-",
      steps: trace.steps.length,
      calls: result.run.tool_calls,
      check: ok,
    });
  }

  const header = ["case", "status", "sec", "target", "materials", "steps", "calls", "check"];
  const widths = header.map((h) =>
    Math.max(h.length, ...rows.map((r) => String(r[colName(r, h)] ?? "").length)),
  );
  const fmt = (vals) => vals.map((v, i) => String(v).padEnd(widths[i])).join(" | ");
  process.stdout.write(fmt(header) + "\n");
  process.stdout.write(widths.map((w) => "-".repeat(w)).join("-+-") + "\n");
  for (const r of rows) {
    process.stdout.write(
      fmt([r.case, r.status, r.seconds, r.target, r.materials, r.steps, r.calls, r.check]) + "\n",
    );
  }
  process.stdout.write(`\n输出目录: ${OUTPUT_DIR}\n轨迹目录: ${TRACE_DIR}\n`);

  if (check) {
    process.stdout.write(allOk ? "\n结果断言: 全部通过\n" : "\n结果断言: 存在失败\n");
    process.exitCode = allOk ? 0 : 1;
  }
}

function colName(row, h) {
  switch (h) {
    case "sec":
      return "seconds";
    default:
      return h;
  }
}

main().catch((err) => {
  process.stderr.write(`运行失败: ${err.stack || err.message}\n`);
  process.exitCode = 2;
});
