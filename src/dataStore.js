import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";

/**
 * 中文无空格场景的模糊匹配：生成 2 字组合（bigram）。
 * 长度 1 的文本退化为单字。避免单字噪声导致弱匹配。
 */
function bigrams(text) {
  const t = String(text || "").replace(/\s+/g, "");
  const out = new Set();
  if (t.length === 1) out.add(t);
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

export class DataStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dataDir] 数据目录，默认仓库 data/
   */
  constructor({ dataDir = DATA_DIR } = {}) {
    const materialsRaw = JSON.parse(
      readFileSync(join(dataDir, "materials.json"), "utf8"),
    );
    const rulesRaw = JSON.parse(
      readFileSync(join(dataDir, "brandRules.json"), "utf8"),
    );
    this.materials = materialsRaw.materials;
    this.rules = rulesRaw.rules;
    this.claimKeywords = rulesRaw.claim_keywords || [];
    this.effectPatterns = rulesRaw.effect_patterns || [];
  }

  getMaterial(id) {
    return this.materials.find((m) => m.id === id) || null;
  }

  /**
   * 检索素材：按查询串与素材（标题/标签/事实）的 bigram 重叠打分。
   * @returns {{count:number, materials:Array<{id,title,facts,tags,score}>}}
   */
  search(query, { limit = 5, minScore = 2 } = {}) {
    const q = String(query || "").trim();
    if (!q) return { count: 0, materials: [] };
    const qGrams = bigrams(q);
    const scored = [];
    for (const m of this.materials) {
      const hay = [m.title, ...(m.tags || []), ...(m.facts || [])].join(" ");
      const hGrams = bigrams(hay);
      let score = 0;
      for (const g of qGrams) if (hGrams.has(g)) score++;
      for (const tag of m.tags || []) if (tag && q.includes(tag)) score += 2;
      if (score >= minScore) scored.push({ ...m, score });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const top = scored.slice(0, limit);
    return { count: top.length, materials: top };
  }
}
