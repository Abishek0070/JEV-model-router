import fs from "node:fs";
import { loadConfig } from "../src/config.js";
import { LocalJevProvider } from "../src/jev/local.js";

async function main(): Promise<void> {
  // Calibration: measures confidence bucket -> observed routing accuracy.
  // Thresholds in config are starting points only — tune them from this output.
  const cfg = loadConfig();
const jev = new LocalJevProvider();
const rows = fs.readFileSync("eval/dataset.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));

const buckets: Record<string, { total: number; correct: number; confSum: number }> = {};
let correct = 0;
for (const r of rows) {
  const d = await jev.decide(r.state);
  const ok = d.tier === r.expected_tier;
  if (ok) correct++;
  const b = d.confidence < 0.7 ? "0.60-0.70" : d.confidence < 0.8 ? "0.70-0.80" : d.confidence < 0.9 ? "0.80-0.90" : "0.90-1.00";
  buckets[b] = buckets[b] || { total: 0, correct: 0, confSum: 0 };
  buckets[b].total++;
  buckets[b].correct += ok ? 1 : 0;
  buckets[b].confSum += d.confidence;
  console.log(`${ok ? "OK  " : "MISS"} expected=${r.expected_tier} got=${d.tier} conf=${d.confidence.toFixed(2)} :: ${r.state.slice(0, 70)}`);
}
console.log(`\naccuracy: ${correct}/${rows.length} = ${(correct / rows.length).toFixed(2)}`);
console.log(`config thresholds: review=${cfg.jev.thresholds.review} (starting point, not a calibrated claim)`);
for (const [b, v] of Object.entries(buckets).sort()) {
  console.log(`${b} -> observed accuracy ${(v.correct / v.total).toFixed(2)} (n=${v.total}, mean_conf=${(v.confSum / v.total).toFixed(2)})`);
}
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
