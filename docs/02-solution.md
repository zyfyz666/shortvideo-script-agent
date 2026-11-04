# 02 方案设计

## 总体架构

```
任务输入
   │
   ▼
┌─────────────────────────────────────────────┐
│                ScriptAgent                   │
│                                             │
│   ┌─────────┐    ┌─────────┐    ┌────────┐  │
│   │   LLM   │───▶│  动作   │───▶│  工具  │  │
│   │ 选动作  │    │ (JSON)  │    │ 执行   │  │
│   └─────────┘    └─────────┘    └───┬────┘  │
│         ▲                           │       │
│         │      ┌────────────┐       │       │
│         └──────│ 观察结果   │◀──────┘       │
│                │ 写回工作区 │               │
│                └────────────┘               │
└─────────────────────────────────────────────┘
   │
   ▼
final_result（结论由工具观察结果推导）
```

核心循环（题目硬性要求）：**模型选择动作 → 执行工具 → 观察结果写回工作区 → 模型根据观察调整下一步或结束**。

## 关键设计决策

### 1. 原生实现，零运行时依赖

工具只有 4 个、状态就是一个"工作区快照"，引入 Agent 框架（LangChain 等）只会增加理解成本与不可控依赖。手写 ReAct 循环约 120 行，每一步都可见、可测、可复盘。仅使用 Node 内置能力：`fetch`（真实模型）、`node:test`（测试）、`node:fs`（数据/轨迹）。

### 2. LLM 双实现，默认离线可跑

- `MockLlm`：确定性决策状态机（`src/llm/mockLlm.js`），根据上一步观察结果决定动作，**离线可复现全部验收点**；
- `OpenAiLlm`：真实模型（OpenAI 兼容 `/chat/completions`，JSON 输出），见 `src/llm/openaiLlm.js`，用于验证同一套流程在真模型下同样成立。

评测代码与单元测试全部跑 Mock；`examples/*_live.json` 提供真实模型运行记录。切换只需 `--llm live`。

### 3. 防虚报：模型只选动作，结论由观察推导

`ScriptAgent._buildResult()` 不信任模型在 `finish` 里的措辞，而是从**工具观察结果快照**推导：

- 时长是否达标 → 来自 `estimate_duration` 的观察（`within_target`）；
- 是否有风险 → 来自 `check_rules` 返回的违规列表；
- 素材来源 → 来自当前脚本草稿各分镜的 `material_ids`；
- 状态（completed/failed/needs_input/max_steps）→ 由工具与预算观察决定。

因此模型无法声称"脚本已完成"却拿不出一份通过检查的脚本。

### 4. 硬约束时长与"估算→修正→再估算"闭环

`estimate_duration` 按 `charsPerSecond=4.2`（字/秒）+ 每分镜 `sceneOverheadSec=0.5` 折算：

```
每分镜时长 = 去空白后旁白字数 / 4.2 + 0.5
总时长     = Σ 每分镜时长
```

模型观察到 `within_target=false` 后，需**压缩脚本 → 重新估算**；连续修正仍超时长则 `finish(failed)`。这条"生成 → 观察 → 调整 → 再验证"的闭环正是题目要考察的。

### 5. 事实接地：R2 / R3 拦截无依据宣传

- **R2**：含产品事实（数字或产品关键词）的分镜必须引用**存在**的素材 ID；
- **R3**：含百分比/效果表述（提升/增长/%…）的文本，必须在被引用素材的事实中找到对应支撑，否则判为"疑似无依据宣传"；
- **R4**：旁白/字幕禁止绝对化用语（最好/第一/100%…）。

这些规则让"编造卖点"在**工具层**就被发现，而不是指望模型自觉。

### 6. 失败路径显式建模

- **工具故障**：`ToolBox` 支持按次数注入故障，抛出 `ToolError`；Agent 捕获为 `observation.ok=false`（`error_type=tool_error`），模型可见并决定重试或终止；
- **预算耗尽**：工具调用次数达到上限时，返回 `status=max_steps` + 原因；
- **LLM 异常 / 无有效动作**：安全终止为 `failed`。

## 模块说明

| 模块 | 职责 |
| --- | --- |
| `src/tools.js` | 4 个业务工具：search_materials / write_script / estimate_duration / check_rules；工作区状态、时长估算、规则检查、故障注入 |
| `src/dataStore.js` | 加载素材与规则；中文 bigram 模糊检索（无空格分词场景） |
| `src/llm/mockLlm.js` | MockLlm（离线确定性策略）+ `buildDraft`（据素材事实拼装脚本） |
| `src/llm/openaiLlm.js` | OpenAiLlm（真实模型）+ 系统提示 + 退避重试 |
| `src/agent.js` | ScriptAgent 主循环；工作区快照；`_buildResult` 观察推导 |
| `src/config.js` | 零依赖 `.env` 解析、配置汇总 |
| `src/cli.js` | 命令行入口（--input / --out / --trace / --fail / --llm / --max-steps） |

## 工具清单

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| search_materials | query | count + materials[{id,title,facts,tags}] |
| write_script | title, segments[], notes? | segment_count, narration_chars, material_ids[] |
| estimate_duration | （读工作区当前草稿） | total_sec, target_sec, within_target, 分段明细 |
| check_rules | （读工作区当前草稿） | passed, violations[]（rule_id + 说明） |

> `request_info` 与 `finish` 是**终止动作**，不调用工具，直接结束循环。

## 安全与边界

- 步数 / 工具调用上限（默认各 16，可配 `--max-steps` / `--max-tool-calls`），超限返回 `max_steps` 并说明原因；
- 真实模型仅通过 HTTP JSON 协议调用，无代码执行、无文件系统自由访问；
- 系统提示中写明硬性边界（不编造、时长硬约束、缺信息先问、失败如实报告）；
- API 密钥只从本地 `.env` 读取（已 gitignore），代码与示例中不含真实密钥。
