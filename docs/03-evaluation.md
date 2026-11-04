# 03 评测方案与结果

## 评测矩阵：验收点 → 示例 → 结果（Mock，确定性）

每个用例在 `examples/` 下都有对应产物：`inputs/<case>.json`（输入）、`outputs/<case>_mock.json`（最终结果）、`traces/<case>_mock.json`（完整决策轨迹）。

| # | 验收点 | 示例 | 输入 | 关键断言 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 1 | 正常生成（超时长修正） | 01_normal | 智能台灯 @ 30s | 首稿超长 → 压缩 → 最终 25.1s ≤ 30s，引用 P01/P02/P03 | PASS |
| 2 | 关键信息缺失 | 02_missing_info | 缺 target_duration_sec | status=needs_input，tool_calls=0，missing 含 target_duration_sec | PASS |
| 3 | 无可用素材 | 03_no_material | 量子计算在线课程 | 改写查询 3 次仍 count=0 → needs_input | PASS |
| 4 | 工具失败后恢复 | 04_tool_failure | 注入 estimate_duration 失败 1 次 | 轨迹含 1 次 tool_error → 重试成功 → completed | PASS |
| 5 | 超时长无法满足 | 05_over_length_fail | 目标 5s | 压缩 2 次仍超时长 → status=failed | PASS |
| 6 | 步数/调用上限 | 单元测试 stub | 永远只调工具的假模型 | status=max_steps，说明原因 | PASS |

`node scripts/run-examples.js --check` 输出：

```
case                | status      | sec  | target | materials   | steps | calls | check
--------------------+-------------+------+--------+-------------+-------+-------+-------
01_normal           | completed   | 25.1 | 30     | P01,P02,P03 | 7     | 6     | PASS
02_missing_info     | needs_input | -    | -      | -           | 1     | 0     | PASS
03_no_material      | needs_input | -    | 30     | -           | 4     | 3     | PASS
04_tool_failure     | completed   | 25.1 | 30     | P01,P02,P03 | 8     | 7     | PASS
05_over_length_fail | failed      | 12.3 | 5      | P01,P02,P03 | 8     | 7     | PASS
结果断言: 全部通过
```

## 多条执行路径（工具结果不同 → 后续动作不同）

**路径 A（01_normal）**：`estimate_duration` 返回 **within_target=false（33.2s > 30s）** → 模型重写更精炼的脚本 → 再估算达标 → 检查通过 → finish。
见 `examples/traces/01_normal_mock.json`。

**路径 B（03_no_material）**：`search_materials` 返回 **count=0** → 改写查询重试（共 3 次）仍 0 → `request_info` 请求补充素材。
见 `examples/traces/03_no_material_mock.json`。

**路径 C（04_tool_failure）**：`estimate_duration` 返回 **tool_error** → 模型重试同一动作 → 成功 → 继续。
见 `examples/traces/04_tool_failure_mock.json`。

**路径 D（02_missing_info）**：输入校验发现缺字段 → 第一步即 `request_info`，**不调用任何工具**。

## 单元测试（17 项，16 通过 / 1 跳过）

```bash
node --test
# tests 17 | pass 16 | fail 0 | skipped 1
```

| 测试文件 | 覆盖 |
| --- | --- |
| `tests/tools.test.js`（9 项） | 时长估算公式；检索召回/空结果；R1 超时长、R2 缺素材引用、R3 无依据效果、R4 绝对化用语；故障注入与恢复；无草稿时报错 |
| `tests/agent.scenarios.test.js`（7 项） | 5 个验收用例状态与关键断言；步数/调用上限 → max_steps；模型异常 → failed；全部输入可被 Mock 跑完 |
| `tests/live.test.js`（1 项，默认跳过） | 真实模型端到端（需 `RUN_LIVE=1` + API Key） |

## 真实模型验证（DeepSeek via OpenAI 兼容网关）

`examples/*_live.json` 下 5 条路径：

| 用例 | 结果 | 说明 |
| --- | --- | --- |
| 01_normal | completed，28.9s ≤ 30s | 检索 → 写稿(超长) → 估算 → 重写 → 估算 → 检查 → finish（模型自行删除了编造卖点） |
| 02_missing_info | needs_input | 缺 target_duration_sec，未调工具 |
| 03_no_material | needs_input | 无对应素材，请求补充 |
| 04_tool_failure | completed，27.3s ≤ 30s | 首次 estimate 故障 → 重试恢复 |
| 05_over_length_fail | completed，4.8s ≤ 5s | 真模型把脚本压到单分镜单事实，**成功**满足 5s（比 Mock 更强） |

> 说明：05 的目标是与 Mock 对照失败路径。真实模型足够"聪明"，用极简脚本也能卡进 5 秒，因此 live 结果为 completed；失败路径由 Mock（`05_over_length_fail`）与单元测试稳定复现。这正说明 Mock 用于验证**框架正确性**，真实模型用于验证**流程普适性**。

## 复现方式

```bash
# 离线示例 + 结果断言（无需任何密钥）
node scripts/run-examples.js --check

# 真实模型示例（需 .env 配置 OPENAI_API_KEY）
node scripts/run-examples.js --live

# 单元测试
node --test

# 单独跑真实模型测试
# PowerShell:  $env:RUN_LIVE=1; node --test tests/live.test.js
```
