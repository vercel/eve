import { defineState } from "eve/context";

function markdownLink(label: string, url: string): string {
  const escapedLabel = label.replace(/([\\[\]])/gu, "\\$1");
  return `[${escapedLabel}](${url})`;
}

function slackMrkdwnLink(label: string, url: string): string {
  const escapedLabel = label.replace(/[<>|]/gu, "");
  return `<${url}|${escapedLabel}>`;
}

export const INVESTIGATION_EVIDENCE_SOURCE_TYPES = [
  "datadog",
  "github",
  "incident",
  "slack",
  "other",
] as const;

export type InvestigationEvidenceSourceType =
  (typeof INVESTIGATION_EVIDENCE_SOURCE_TYPES)[number];

export interface InvestigationEvidenceInput {
  finding: string;
  sourceLabel: string;
  sourceType: InvestigationEvidenceSourceType;
  sourceUrl: string;
}

export interface InvestigationEvidence extends InvestigationEvidenceInput {
  id: string;
}

export interface InvestigationEvidenceState {
  items: InvestigationEvidence[];
  nextId: number;
  turnId: string | null;
}

const investigationEvidenceState = defineState<InvestigationEvidenceState>(
  "sre.investigation-evidence",
  () => ({ items: [], nextId: 1, turnId: null })
);

function stateForTurn(
  state: InvestigationEvidenceState,
  turnId: string
): InvestigationEvidenceState {
  return state.turnId === turnId ? state : { items: [], nextId: 1, turnId };
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeInvestigationEvidence(
  evidence: InvestigationEvidenceInput
): InvestigationEvidenceInput {
  return {
    finding: normalizeText(evidence.finding),
    sourceLabel: normalizeText(evidence.sourceLabel),
    sourceType: evidence.sourceType,
    sourceUrl: evidence.sourceUrl.trim(),
  };
}

export function addInvestigationEvidence(
  state: InvestigationEvidenceState,
  turnId: string,
  evidence: InvestigationEvidenceInput
): {
  item: InvestigationEvidence;
  recorded: boolean;
  state: InvestigationEvidenceState;
} {
  const normalized = normalizeInvestigationEvidence(evidence);
  const current = stateForTurn(state, turnId);
  const existing = current.items.find(
    (candidate) =>
      candidate.sourceUrl === normalized.sourceUrl &&
      candidate.finding === normalized.finding
  );

  if (existing) {
    return { item: existing, recorded: false, state: current };
  }

  const added = { ...normalized, id: `evidence-${current.nextId}` };
  return {
    item: added,
    recorded: true,
    state: {
      items: [...current.items, added],
      nextId: current.nextId + 1,
      turnId,
    },
  };
}

export function removeInvestigationEvidenceFromState(
  state: InvestigationEvidenceState,
  turnId: string,
  evidenceId: string
): {
  removed: InvestigationEvidence | null;
  state: InvestigationEvidenceState;
} {
  const current = stateForTurn(state, turnId);
  const removed = current.items.find((item) => item.id === evidenceId) ?? null;

  if (!removed) {
    return { removed: null, state: current };
  }

  return {
    removed,
    state: {
      ...current,
      items: current.items.filter((item) => item.id !== evidenceId),
    },
  };
}

export function recordInvestigationEvidence(
  turnId: string,
  evidence: InvestigationEvidenceInput
): { count: number; evidenceId: string; recorded: boolean } {
  let outcome = { evidenceId: "", recorded: false };
  investigationEvidenceState.update((state) => {
    const next = addInvestigationEvidence(state, turnId, evidence);
    outcome = { evidenceId: next.item.id, recorded: next.recorded };
    return next.state;
  });

  return {
    count: investigationEvidenceState.get().items.length,
    ...outcome,
  };
}

export function removeInvestigationEvidence(
  turnId: string,
  evidenceId: string
): { count: number; removed: InvestigationEvidence | null } {
  let removed: InvestigationEvidence | null = null;
  investigationEvidenceState.update((state) => {
    const { removed: nextRemoved, state: nextState } =
      removeInvestigationEvidenceFromState(state, turnId, evidenceId);
    removed = nextRemoved;
    return nextState;
  });

  return {
    count: investigationEvidenceState.get().items.length,
    removed,
  };
}

export function getInvestigationEvidence(
  turnId: string
): readonly InvestigationEvidence[] {
  const state = investigationEvidenceState.get();
  return state.turnId === turnId ? state.items : [];
}

function evidenceLines(
  items: readonly InvestigationEvidence[],
  bullet: string,
  link: (label: string, url: string) => string
): string[] {
  return items.map(
    (item) =>
      `${bullet} ${link(item.sourceLabel, item.sourceUrl)} — ${item.finding}`
  );
}

export function renderInvestigationEvidence(
  items: readonly InvestigationEvidence[]
): string | null {
  if (items.length === 0) {
    return null;
  }

  return ["## Evidence", ...evidenceLines(items, "-", markdownLink)].join("\n");
}

export function renderCompactInvestigationEvidence(
  items: readonly InvestigationEvidence[]
): string {
  if (items.length === 0) {
    return "Evidence\nNo source links were recorded; treat this conclusion as unverified.";
  }

  return ["Evidence", ...evidenceLines(items, "•", slackMrkdwnLink)].join("\n");
}

export function appendInvestigationEvidenceToAnswer(
  answer: string,
  items: readonly InvestigationEvidence[]
): string {
  const evidence = renderInvestigationEvidence(items);
  if (evidence) {
    return `${answer.trim()}\n\n${evidence}`;
  }

  return answer;
}
