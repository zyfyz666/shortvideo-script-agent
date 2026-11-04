import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateDuration, checkRules, ToolBox, ToolError } from "../src/tools.js";
import { DataStore } from "../src/dataStore.js";

const store = new DataStore();

test("estimateDuration: 按语速与分镜开销累加", () => {
  const segs = [
    { shot: 1, narration: "一二三四五十" }, // 6 字
    { shot: 2, narration: "六七八九十" }, // 5 字
  ];
  // 默认 4.2 字/秒，每分镜 +0.5s
  const { total_sec, segments } = estimateDuration(segs);
  assert.equal(segments.length, 2);
  assert.ok(Math.abs(total_sec - (11 / 4.2 + 1.0)) < 0.11, `total=${total_sec}`);
});

test("DataStore.search: 智能台灯召回 P01/P02/P03，无关注查询返回 0", () => {
  const hit = store.search("智能台灯");
  const ids = hit.materials.map((m) => m.id);
  assert.ok(ids.includes("P01") && ids.includes("P02") && ids.includes("P03"));
  const miss = store.search("量子计算在线课程");
  assert.equal(miss.count, 0);
});

test("checkRules: 超时长触发 R1", () => {
  const segs = [{ shot: 1, narration: "支持字幕功能", material_ids: ["P01"] }];
  const violations = checkRules(segs, { target_duration_sec: 1 }, store, 5);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule_id, "R1");
});

test("checkRules: 含事实但无素材引用触发 R2", () => {
  const segs = [{ shot: 1, narration: "续航 12 小时", material_ids: [] }];
  const v = checkRules(segs, { target_duration_sec: 60 }, store, 3);
  assert.ok(v.some((x) => x.rule_id === "R2"));
});

test("checkRules: 编造效果数据触发 R3（关键缺陷）", () => {
  const segs = [
    { shot: 1, narration: "使用后效率提升 80%", material_ids: ["P01"] },
  ];
  const v = checkRules(segs, { target_duration_sec: 60 }, store, 3);
  assert.ok(v.some((x) => x.rule_id === "R3"), JSON.stringify(v));
});

test("checkRules: 绝对化用语触发 R4", () => {
  const segs = [{ shot: 1, narration: "全网最好的台灯", material_ids: ["P01"] }];
  const v = checkRules(segs, { target_duration_sec: 60 }, store, 3);
  assert.ok(v.some((x) => x.rule_id === "R4"));
});

test("ToolBox: 注入故障按次数抛出，随后恢复", () => {
  const tb = new ToolBox(store, { failures: { estimate_duration: 1 } });
  tb.currentTarget = 30;
  tb.call("write_script", {
    title: "t",
    segments: [{ shot: 1, narration: "支持字幕功能", material_ids: ["P01"] }],
  });
  assert.throws(() => tb.call("estimate_duration", {}), ToolError);
  const est = tb.call("estimate_duration", {});
  assert.equal(est.ok, true);
  assert.ok(est.total_sec > 0);
});

test("ToolBox: 没有草稿时估算/检查报错", () => {
  const tb = new ToolBox(store, {});
  assert.throws(() => tb.call("estimate_duration", {}), ToolError);
  assert.throws(() => tb.call("check_rules", {}), ToolError);
});
