import { readFileSync, existsSync } from "node:fs";
const rd = (p) =>
  existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
const exp = {
  "account-billing": ["index__resolve_account", "support__support_billing"],
  account: ["index__resolve_account"],
  cases: ["support__search_cases"],
  cost: ["d0__query_cost"],
  expenses: ["expense_policy_lookup"],
  "incident-cost": ["sre__status_page_incidents_list", "d0__query_cost"],
  incidents: ["sre__status_page_incidents_list"],
  oncall: ["sre__oncall_schedule_get"],
  release: ["release_train_schedule"],
  usage: ["d0__usage_summary"],
};
const ref = (n) => `REF-${n.replaceAll("_", "-").toUpperCase()}`;
const W = "../baseline/measurements.jsonl";
let rows = rd(W)
  .filter((r) => r.arm !== "js" && r.arm !== "py")
  .map((r) => ({ ...r, label: r.arm }));
for (const m of ["gpt", "opus", "sonnet"]) {
  rows.push(...rd(`./${m}/m.jsonl`).map((r) => ({ ...r, label: r.arm })));
  rows.push(...rd(`./nudge-${m}/m.jsonl`).map((r) => ({ ...r, label: r.arm + "+nudge" })));
}
const harness = (r) => String(r.errorClass || "").startsWith("harness");
const g = {};
for (const r of rows) {
  const k = r.model + "|" + r.label;
  (g[k] ??= []).push(r);
}
const order = ["direct", "deferred", "subagents", "js", "js+nudge", "py", "py+nudge"];
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
console.log(
  "| Model | Arm | Runs | Strict success | Answer correct | Used program | Mean input tokens | Mean model calls | Mean latency (s) |\n|---|---|---:|---:|---:|---:|---:|---:|---:|",
);
for (const model of [...new Set(rows.map((r) => r.model))].sort())
  for (const l of order) {
    const a = g[model + "|" + l];
    if (!a) continue;
    const ok = a.filter((r) => !harness(r)); // harness errors reported separately
    const strict = ok.filter((r) => r.success).length;
    const corr = ok.filter(
      (r) =>
        exp[r.id].every((n) => (r.message || "").includes(ref(n))) && r.errorClass !== "timeout",
    ).length;
    const prog = ok.filter((r) => r.programAttempts > 0).length;
    console.log(
      `| ${model.split("/")[1]} | ${l} | ${ok.length}${a.length !== ok.length ? ` (+${a.length - ok.length} harness err)` : ""} | ${((100 * strict) / ok.length).toFixed(0)}% | ${((100 * corr) / ok.length).toFixed(0)}% | ${((100 * prog) / ok.length).toFixed(0)}% | ${mean(ok.map((r) => r.inputTokens)).toFixed(0)} | ${mean(ok.map((r) => r.modelCalls)).toFixed(1)} | ${(mean(ok.map((r) => r.latencyMs)) / 1000).toFixed(1)} |`,
    );
  }
