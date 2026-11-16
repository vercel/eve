import assert from "node:assert/strict";
import test from "node:test";
import {
  addInvestigationEvidence,
  appendInvestigationEvidenceToAnswer,
  type InvestigationEvidence,
  type InvestigationEvidenceState,
  isHttpUrl,
  removeInvestigationEvidenceFromState,
  renderCompactInvestigationEvidence,
  renderInvestigationEvidence,
} from "./evidence.ts";

const initialState: InvestigationEvidenceState = {
  items: [],
  nextId: 1,
  turnId: null,
};

function evidence(
  overrides: Partial<InvestigationEvidence> = {}
): InvestigationEvidence {
  return {
    finding: "5xx errors rose from 1% to 12%.",
    id: "evidence-1",
    sourceLabel: "API error-rate graph",
    sourceType: "datadog",
    sourceUrl: "https://app.datadoghq.com/metric/explorer?query=api.errors",
    ...overrides,
  };
}

test("isHttpUrl accepts only HTTP and HTTPS URLs", () => {
  assert.equal(isHttpUrl("https://example.com/evidence"), true);
  assert.equal(isHttpUrl("http://example.com/evidence"), true);
  assert.equal(isHttpUrl("ftp://example.com/evidence"), false);
  assert.equal(isHttpUrl("not a url"), false);
});

test("addInvestigationEvidence preserves discovery order and normalizes text", () => {
  const first = addInvestigationEvidence(
    initialState,
    "turn-1",
    evidence({
      finding: "  Errors   rose rapidly.  ",
      sourceLabel: "  Error graph  ",
    })
  );
  const second = addInvestigationEvidence(
    first.state,
    "turn-1",
    evidence({
      finding: "A deployment completed immediately before the spike.",
      sourceLabel: "Deployment event",
      sourceType: "github",
      sourceUrl: "https://github.com/example/shop-api/commit/abc123",
    })
  );

  assert.deepEqual(
    second.state.items.map((item) => item.finding),
    [
      "Errors rose rapidly.",
      "A deployment completed immediately before the spike.",
    ]
  );
  assert.equal(second.state.items[0]?.sourceLabel, "Error graph");
  assert.deepEqual(
    second.state.items.map((item) => item.id),
    ["evidence-1", "evidence-2"]
  );
  assert.equal(second.recorded, true);
  assert.equal(second.item.id, "evidence-2");
});

test("addInvestigationEvidence deduplicates only identical URL and finding pairs", () => {
  const first = addInvestigationEvidence(initialState, "turn-1", evidence());
  const duplicate = addInvestigationEvidence(first.state, "turn-1", evidence());
  const sameSourceNewFinding = addInvestigationEvidence(
    duplicate.state,
    "turn-1",
    evidence({ finding: "Latency rose to 4.2 seconds." })
  );

  assert.equal(duplicate.state.items.length, 1);
  assert.equal(duplicate.recorded, false);
  assert.equal(duplicate.item.id, "evidence-1");
  assert.equal(sameSourceNewFinding.state.items.length, 2);
  assert.equal(sameSourceNewFinding.state.nextId, 3);
});

test("removeInvestigationEvidenceFromState removes by stable ID without reusing IDs", () => {
  const first = addInvestigationEvidence(initialState, "turn-1", evidence());
  const second = addInvestigationEvidence(
    first.state,
    "turn-1",
    evidence({
      finding: "Latency rose.",
      sourceUrl: "https://example.com/latency",
    })
  );
  const third = addInvestigationEvidence(
    second.state,
    "turn-1",
    evidence({
      finding: "Errors recovered.",
      sourceUrl: "https://example.com/recovery",
    })
  );
  const removed = removeInvestigationEvidenceFromState(
    third.state,
    "turn-1",
    "evidence-2"
  );
  const fourth = addInvestigationEvidence(
    removed.state,
    "turn-1",
    evidence({
      finding: "Traffic stabilized.",
      sourceUrl: "https://example.com/traffic",
    })
  );

  assert.equal(removed.removed?.finding, "Latency rose.");
  assert.deepEqual(
    fourth.state.items.map((item) => item.id),
    ["evidence-1", "evidence-3", "evidence-4"]
  );
});

test("removeInvestigationEvidenceFromState cannot remove evidence from another turn", () => {
  const firstTurn = addInvestigationEvidence(
    initialState,
    "turn-1",
    evidence()
  );
  const result = removeInvestigationEvidenceFromState(
    firstTurn.state,
    "turn-2",
    "evidence-1"
  );

  assert.equal(result.removed, null);
  assert.deepEqual(result.state, { items: [], nextId: 1, turnId: "turn-2" });
});

test("addInvestigationEvidence resets items when the turn changes", () => {
  const firstTurn = addInvestigationEvidence(
    initialState,
    "turn-1",
    evidence()
  );
  const secondTurn = addInvestigationEvidence(
    firstTurn.state,
    "turn-2",
    evidence({ finding: "The monitor recovered.", sourceLabel: "Monitor" })
  );

  assert.equal(secondTurn.state.turnId, "turn-2");
  assert.deepEqual(
    secondTurn.state.items.map((item) => item.finding),
    ["The monitor recovered."]
  );
});

test("renderInvestigationEvidence renders every item with an escaped Markdown link", () => {
  const rendered = renderInvestigationEvidence([
    evidence({ sourceLabel: "API [errors]" }),
    evidence({
      finding: "The implicated change touched authentication middleware.",
      sourceLabel: "PR #456",
      sourceType: "github",
      sourceUrl: "https://github.com/example/shop-api/pull/456",
    }),
  ]);

  assert.equal(
    rendered,
    [
      "## Evidence",
      "- [API \\[errors\\]](https://app.datadoghq.com/metric/explorer?query=api.errors) — 5xx errors rose from 1% to 12%.",
      "- [PR #456](https://github.com/example/shop-api/pull/456) — The implicated change touched authentication middleware.",
    ].join("\n")
  );
});

test("renderCompactInvestigationEvidence renders each shortlink with its finding", () => {
  const rendered = renderCompactInvestigationEvidence([
    evidence({ sourceLabel: "API [errors]" }),
    evidence({ finding: "Latency also rose.", sourceLabel: "Same graph" }),
    evidence({
      finding: "The implicated change touched authentication middleware.",
      sourceLabel: "PR #456",
      sourceType: "github",
      sourceUrl: "https://github.com/example/shop-api/pull/456",
    }),
  ]);

  assert.equal(
    rendered,
    "Evidence\n• <https://app.datadoghq.com/metric/explorer?query=api.errors|API [errors]> — 5xx errors rose from 1% to 12%.\n• <https://app.datadoghq.com/metric/explorer?query=api.errors|Same graph> — Latency also rose.\n• <https://github.com/example/shop-api/pull/456|PR #456> — The implicated change touched authentication middleware."
  );
});

test("renderCompactInvestigationEvidence makes missing sources visibly unverified", () => {
  assert.equal(
    renderCompactInvestigationEvidence([]),
    "Evidence\nNo source links were recorded; treat this conclusion as unverified."
  );
});

test("appendInvestigationEvidenceToAnswer leaves unrelated unsourced answers unchanged", () => {
  assert.equal(
    appendInvestigationEvidenceToAnswer("Hello there.", []),
    "Hello there."
  );
});

test("appendInvestigationEvidenceToAnswer appends recorded evidence", () => {
  assert.equal(
    appendInvestigationEvidenceToAnswer("Likely root cause: overload.", [
      evidence(),
    ]),
    [
      "Likely root cause: overload.",
      "",
      "## Evidence",
      "- [API error-rate graph](https://app.datadoghq.com/metric/explorer?query=api.errors) — 5xx errors rose from 1% to 12%.",
    ].join("\n")
  );
});
