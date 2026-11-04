import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 仓库根目录（src/ 的上一层）。 */
export const ROOT_DIR = resolve(__dirname, "..");

/**
 * 极简 .env 解析器（零依赖）。已存在的进程环境变量优先，不被文件覆盖。
 */
export function loadDotEnv(envPath = join(ROOT_DIR, ".env")) {
  if (!existsSync(envPath)) return {};
  const parsed = {};
  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  for (const [k, v] of Object.entries(parsed)) {
    // 项目自带 .env 优先于外部 shell 环境，保证按仓库内配置可复现运行。
    process.env[k] = v;
  }
  return parsed;
}

/** 读取整数环境变量，非法值回退默认。 */
function intEnv(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * 汇总运行配置。任何字段都可用命令行参数覆盖。
 */
export function getConfig(overrides = {}) {
  loadDotEnv();
  const config = {
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.chat.csu.edu.cn/v1",
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || "DeepSeek",
    timeoutMs: intEnv("OPENAI_TIMEOUT_MS", 120000),
    maxSteps: intEnv("AGENT_MAX_STEPS", 16),
    maxToolCalls: intEnv("AGENT_MAX_TOOL_CALLS", 16),
  };
  return { ...config, ...stripUndefined(overrides) };
}

function stripUndefined(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null),
  );
}

export const DATA_DIR = join(ROOT_DIR, "data");
