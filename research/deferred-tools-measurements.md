# Deferred tools: three-arm measurement

Pilot against PR #4400 head `383f8eb6`. One repetition of ten tasks per
configuration: 120 tasks total. This does **not** demonstrate the success-rate
ship gate: every arm saturated at 100% success.

## Results

Input tokens include cached inputs. Cache ratio is total cache-read tokens /
total input tokens. Latency is mean wall time around `t.send`, excluding CLI
startup, compilation and subsequent child-stream inspection.

| Model                     | Size     | Arm       | Success | Mean input tokens | Cache read ratio | Mean model calls | Mean latency (s) |
| ------------------------- | -------- | --------- | ------: | ----------------: | ---------------: | ---------------: | ---------------: |
| openai/gpt-6.1-sol        | moderate | direct    |   10/10 |            7012.4 |            93.6% |              2.0 |             6.92 |
| openai/gpt-6.1-sol        | moderate | deferred  |   10/10 |           10374.6 |            91.6% |              3.6 |             9.06 |
| openai/gpt-6.1-sol        | moderate | subagents |   10/10 |           16942.8 |            88.3% |              6.1 |            30.09 |
| openai/gpt-6.1-sol        | large    | direct    |   10/10 |           22124.4 |            94.5% |              2.0 |             7.27 |
| openai/gpt-6.1-sol        | large    | deferred  |   10/10 |           13756.7 |            83.7% |              3.4 |             8.03 |
| openai/gpt-6.1-sol        | large    | subagents |   10/10 |           21120.5 |            88.6% |              6.1 |            23.31 |
| anthropic/claude-opus-5.5 | moderate | direct    |   10/10 |           15264.0 |            93.5% |              2.0 |             4.72 |
| anthropic/claude-opus-5.5 | moderate | deferred  |   10/10 |           17056.8 |            92.4% |              3.1 |             9.34 |
| anthropic/claude-opus-5.5 | moderate | subagents |   10/10 |           33536.7 |            88.1% |              5.9 |            15.36 |
| anthropic/claude-opus-5.5 | large    | direct    |   10/10 |           56554.1 |            94.6% |              2.0 |             5.96 |
| anthropic/claude-opus-5.5 | large    | deferred  |   10/10 |           18054.1 |            90.2% |              3.1 |             9.09 |
| anthropic/claude-opus-5.5 | large    | subagents |   10/10 |           43909.1 |            87.7% |              5.9 |            16.20 |

## Gate assessment

The gate in `research/deferred-tools.md` specifies **success**, not efficiency:

- **Arm 2 matches arm 1 at moderate count: observed yes**, both models 10/10.
  This small sample does not establish statistical equivalence.
- **Arm 2 beats arm 1 on success at large count: not demonstrated** (ties).
  Deferred saves 37.8% input tokens for GPT and 68.1% for Opus at large count,
  but direct has fewer model calls and lower latency in all configurations.
- **Arm 2 beats arm 3 on success: not demonstrated** (ties). Deferred uses
  fewer input tokens and calls and less latency in all configurations.
- **No cache regression after discovery: not established.** Aggregate cache
  read ratios are lower for deferred than direct in all four size/model pairs;
  the experiment does not isolate before/after-discovery cache stability.
- Connection, skill, empty-catalog and web-routing gates are outside this task
  set. No claim is made about them.

**Overall: success-rate measurement ship gate not demonstrated.** Harder tasks
are needed to distinguish success; repetitions alone do not solve saturation.

## Design and measurement

All arms share catalog, prompts, instructions and model. Moderate has 30
long-tail tools; large has 200. Large adds plausible synthetic namespace tools
with reporting-period descriptions and optional string inputs. Built-in head
tools remain available in all arms. Five specialists are exposed only in the
subagents arm, each with direct tools from its namespace and default built-ins.
Direct and deferred roots expose the same 30/200 tools, differing only in the
`deferred` flag. Specialist tool counts vary with namespace distribution.

Ten independent one-turn tasks cover incidents, on-call, costs, usage, CRM,
support cases, releases, expenses, incident + cost, and account + billing.
Eight require one tool; two require two tools from different namespaces.
Requests describe operations without naming tools. Results are fixed.
Success requires a nonfailed turn and every expected tool's exact reference in
the final response. The harness additionally asserts every expected tool was
requested in the parent or child stream. That assertion was added after the
matrix; all 120 saved request lists were subsequently checked and passed it.
A large Opus account/billing subagent smoke run after adding it passed 3/3 gates.

Model calls and usage are counts/sums of `step.completed` events. After the
parent completes, each unique child session's durable stream is read from
index zero with `follow: false`. This includes child usage without counting
parent rolled-up session totals twice. Zero missing step-usage records were
observed. Token usage is provider-reported AI SDK input tokens and cache reads.
Raw rows preserve tool inputs and final responses; verbose logs preserve runner
verdicts and workflow run IDs. Every configuration had ten passing evals.

## Behavior and caveats

No wrong-tool-only answers, skipped-search failures or schema errors caused a
failure. Deferred made 52 searches for 40 tasks, sometimes querying an extra
customer tool. Subagents made 48 delegations, 47 task-wait calls and 10 extra
incident-detail lookups; some cross-namespace delegations were sequential.
These extra calls are included in the reported totals.

N=1 per task/configuration, ten heterogeneous tasks per aggregate. No uncertainty
estimate, cold-cache control, randomized arm order, production load or adversarial
ambiguity. Runs are sequential (concurrency 1), direct then deferred then
subagents within each model/size. Provider caches are shared across tasks;
later tasks often reuse prefixes. Synthetic padding and reference-only results
make this a routing/overhead probe, not a realistic answer-quality benchmark.
No skills or connections are modeled. More repetitions improve timing confidence,
but harder tasks are needed to evaluate the literal success gate.

## Reproduce

The `agent-tool-arms` fixture is marked `"e2e": { "manual": true }`, so CI
fixture discovery skips it; run it by hand. It needs `AI_GATEWAY_API_KEY` and
a clean environment (no inherited `EVE_*` / `WORKFLOW_*` credentials).

```sh
pnpm install
pnpm --filter eve run build
cd e2e/fixtures/agent-tool-arms
EVE_ARMS_OUTPUT=/tmp/arms/measurements.jsonl pnpm run measure
```

Runner defaults: both CI models, both sizes, all three arms, one repetition.
Set `EVE_ARMS_REPETITIONS=3` for three repetitions. Optional comma-separated
filters: `EVE_ARMS_MODELS`, `EVE_ARMS_MODES`, `EVE_ARMS_SIZES`.
Use a fresh output file: rows append, so reusing one duplicates observations.
Each configuration runs `pnpm exec eve eval --strict --verbose`, setting
`EVE_E2E_MODEL`, `EVE_ARMS_MODE`, `EVE_ARMS_SIZE`, `EVE_ARMS_REPETITION`.

Single configuration:

```sh
cd e2e/fixtures/agent-tool-arms
EVE_E2E_MODEL=anthropic/claude-opus-5.5 \
  EVE_ARMS_MODE=subagents EVE_ARMS_SIZE=large \
  pnpm exec eve eval account-billing --strict --verbose
```

Committed artifacts under the fixture: `results/measurements.jsonl`,
`results/summary.md`, and one verbose CLI log per configuration.
