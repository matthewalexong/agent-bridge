// Ledger: JSONL accounting of every model call, plus savings math.
import fs from "node:fs";
import path from "node:path";

export class Ledger {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.entries = [];
  }
  record(entry) {
    this.entries.push({ ts: new Date().toISOString(), ...entry });
    fs.appendFileSync(this.file, JSON.stringify(entry) + "\n");
  }
  summary() {
    const byTier = {};
    for (const e of this.entries) {
      const t = byTier[e.tier] ||= { calls: 0, promptTokens: 0, completionTokens: 0, ms: 0 };
      t.calls += 1;
      t.promptTokens += e.promptTokens || 0;
      t.completionTokens += e.completionTokens || 0;
      t.ms += e.ms || 0;
    }
    // Frontier rate estimate (per 1M tokens) — configurable, clearly an estimate.
    const frontierRateIn = parseFloat(process.env.FRONTIER_RATE_IN_PER_MTOK || "2.50");
    const frontierRateOut = parseFloat(process.env.FRONTIER_RATE_OUT_PER_MTOK || "10.00");
    const local = byTier.local || { calls: 0, promptTokens: 0, completionTokens: 0, ms: 0 };
    const frontier = byTier.frontier || { calls: 0, promptTokens: 0, completionTokens: 0, ms: 0 };
    const actualCost = ((frontier.promptTokens * frontierRateIn + frontier.completionTokens * frontierRateOut) / 1e6);
    // Counterfactual: same total iterations all on frontier
    const totalCalls = local.calls + frontier.calls;
    const avgTokensPerCall = totalCalls ? (local.promptTokens + local.completionTokens + frontier.promptTokens + frontier.completionTokens) / totalCalls : 0;
    const frontierOnlyCost = (totalCalls * avgTokensPerCall * (frontierRateIn + frontierRateOut) / 2 / 1e6);
    return { byTier, local, frontier, actualCostUsd: actualCost, frontierOnlyEstimateUsd: frontierOnlyCost, savingsUsd: Math.max(0, frontierOnlyCost - actualCost) };
  }
  print() {
    const s = this.summary();
    const line = (t, d) => `  ${t.padEnd(9)} calls=${String(d.calls).padStart(2)}  prompt=${String(d.promptTokens).padStart(7)}  gen=${String(d.completionTokens).padStart(6)}  ${(d.ms / 1000).toFixed(1)}s`;
    console.log("\n=== LEDGER ===");
    console.log(line("local", s.local));
    console.log(line("frontier", s.frontier));
    console.log(`  frontier spend (estimate): $${s.actualCostUsd.toFixed(4)}   vs frontier-only estimate: $${s.frontierOnlyEstimateUsd.toFixed(4)}   => saved ~$${s.savingsUsd.toFixed(4)}`);
  }
}
