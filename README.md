# 短视频脚本 Agent

小影校招 AI Agent 方向笔试项目。一个基于 **ReAct 循环**（模型选择动作 → 执行工具 → 观察结果 → 调整或结束）的短视频脚本 Agent：检索产品素材 → 撰写有事实依据的脚本 → 估算时长 → 检查品牌规则 → 修正 → 输出**可编辑脚本**，或在信息不足 / 无法满足约束时给出**明确的未完成状态**。

## 快速开始

```bash
# 1. 无需安装任何依赖（纯 Node 内置模块，Node >= 18.17）

# 2. 离线运行（默认 Mock 决策器，无需任何 API 密钥）
node src/cli.js run --input examples/inputs/01_normal.json --llm mock

# 3. 运行单元测试（17 项，其中 1 项真实模型测试默认跳过）
node --test

# 4. 一键生成全部验收示例并做结果断言
node scripts/run-examples.js --check
```

接入真实模型（可选）：复制 `.env.example` 为 `.env`，填入 OpenAI 兼容端点与密钥，然后 `--llm live`。

## 命令行用法

```bash
# 处理单个任务（从文件读取输入）
node src/cli.js run --input examples/inputs/01_normal.json --llm mock

# 把结果 / 决策轨迹写入文件
node src/cli.js run --input examples/inputs/04_tool_failure.json --out out.json --trace trace.json

# 注入工具故障（验证失败恢复路径）
node src/cli.js run --input examples/inputs/01_normal.json --fail estimate_duration=1

# 限制步数 / 工具调用次数（超限返回明确未完成状态）
node src/cli.js run --input examples/inputs/01_normal.json --max-steps 3

# 使用真实模型（需 .env 或命令行提供密钥）
node src/cli.js run --input examples/inputs/01_normal.json --llm live
```

## 目录结构

```
├── src/
│   ├── agent.js        # ReAct 主循环 + 由工具观察推导最终结果
│   ├── tools.js        # 4 个业务工具（检索/写稿/估时长/查规则）+ 故障注入
│   ├── dataStore.js    # 素材与规则加载、中文 bigram 模糊检索
│   ├── llm/
│   │   ├── mockLlm.js   # MockLlm：离线确定性决策状态机
│   │   ├── openaiLlm.js # OpenAiLlm：真实模型（OpenAI 兼容协议）
│   │   └── index.js     # createLlm 工厂
│   ├── config.js       # 零依赖 .env 解析与配置汇总
│   ├── cli.js          # 命令行入口
│   └── index.js        # 库入口
├── data/               # 产品素材 + 品牌规则（合成数据）
├── tests/              # node:test 单元测试
├── examples/           # 输入/输出/决策轨迹（验收证据）
│   ├── inputs/         # 5 个验收用例输入
│   ├── outputs/        # 运行结果（*_mock.json / *_live.json）
│   └── traces/         # 完整决策轨迹（*_mock.json / *_live.json）
├── scripts/            # 示例批量运行脚本
└── docs/               # 01 需求 / 02 方案 / 03 评测 / 04 AI 使用 / 05 复盘
```

## 验收点 → 证据对照

| 验收点 | 示例（examples/） | 结果 |
| --- | --- | --- |
| 正常生成（超时长后压缩达标） | `01_normal` | completed，25.1s ≤ 30s，引用 P01/P02/P03 |
| 关键信息缺失 | `02_missing_info`（缺 target_duration_sec） | needs_input，未调用任何工具 |
| 无可用素材 | `03_no_material` | needs_input（改写查询 3 次后请求补充素材） |
| 工具失败后恢复 | `04_tool_failure` | completed（首次 estimate 失败 → 重试成功） |
| 超时长无法满足 → 明确失败 | `05_over_length_fail`（目标 5s） | failed（压缩 2 次仍超时长） |
| 步数/调用上限 → 明确未完成 | `tests/agent.scenarios.test.js` | max_steps |
| 真实模型一致性 | `examples/*_live.json` | 5 条路径均符合预期 |

## 设计要点（详见 docs/）

1. **ReAct 循环**：模型只选动作 → 工具执行 → 观察写回工作区 → 模型据观察调整或结束（`src/agent.js`）；
2. **防虚报**：最终结论由工具观察结果推导，模型无法凭空声称"脚本已完成/时长达标"（`_buildResult`）；
3. **事实接地**：脚本每个产品事实必须来自素材并在分镜 `material_ids` 中标注，规则 R2/R3 拦截"无依据宣传"；
4. **硬约束时长**：目标时长是硬约束，`estimate_duration` + 规则 R1 驱动模型压缩或明确失败，绝不静默超标；
5. **失败显式**：工具故障 → 观察可见 → 重试或明确失败；预算耗尽 → `max_steps`；缺信息/缺素材 → `needs_input`，均不假装成功。

## 环境变量（仅真实模型需要）

见 `.env.example`。默认 `--llm mock` 完全离线。真实模型需要 `OPENAI_API_KEY`（以及可选的 `OPENAI_BASE_URL` / `OPENAI_MODEL`）。密钥只从本地 `.env` 读取，已 gitignore，代码与示例中不含真实密钥。
