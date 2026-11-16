import { type DecisionQuestion, decide } from "eve/ai";
import { MODELS } from "../models.js";

/**
 * Fast, typed triage with a decision model.
 *
 * @remarks
 * A decision model answers closed questions (pick one, yes or no) about a
 * shared state in a single call, in a fraction of the time a language-model
 * turn takes, and it cannot answer with anything except the options it was
 * given. That makes it a good fit for mechanical judgments that would
 * otherwise cost a whole agent turn: classifying a work item, choosing its
 * labels from the repository's own vocabulary, spotting a duplicate, and
 * sorting a red CI run into "the code is wrong" versus "the run was unlucky".
 *
 * Two properties matter for safety. The work item is untrusted text, and a
 * decision model has no free-form output for injected instructions to steer:
 * the worst a hostile issue body can do is earn itself a wrong label. And the
 * label answers are booleans over labels that already exist, so the factory
 * can never invent one.
 *
 * This module only makes decisions. GitHub reads and writes stay on the
 * repository-scoped extension with its existing authorization policies.
 */

export const WORK_ITEM_TYPES = [
  "bug",
  "feature",
  "refactor",
  "question",
  "chore",
  "security",
] as const;
export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export const COMPLEXITIES = ["trivial", "small", "medium", "large"] as const;

export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Complexity = (typeof COMPLEXITIES)[number];

/**
 * Where the orchestrator sends a triaged item next.
 *
 * - `pipeline`: clear enough to plan; go straight to the analyst.
 * - `clarify`: too thin or ambiguous; the classifier station writes the
 *   questions to ask.
 * - `answer`: a question, not a change request; answer it, build nothing.
 * - `duplicate`: an existing issue already covers it.
 */
export type TriageLane = "pipeline" | "clarify" | "answer" | "duplicate";

export interface WorkItem {
  readonly body: string;
  readonly title: string;
}

export interface RepoLabel {
  readonly description?: string | null;
  readonly name: string;
}

export interface DuplicateCandidate {
  readonly number: number;
  readonly state?: string;
  readonly title: string;
}

interface TriageDependencies {
  readonly signal?: AbortSignal;
}

export interface Triage {
  readonly actionable: boolean;
  readonly complexity: Complexity;
  /**
   * The model's probability for each choice it made, or null when the
   * provider returned no distribution.
   */
  readonly confidence: {
    readonly complexity: number | null;
    readonly priority: number | null;
    readonly type: number | null;
  };
  /** Numbers of existing issues this item duplicates, most likely first. */
  readonly duplicates: readonly number[];
  /** Labels to apply, all taken from the vocabulary that was passed in. */
  readonly labels: readonly string[];
  readonly lane: TriageLane;
  readonly needs_clarification: boolean;
  readonly needs_research: boolean;
  readonly priority: Priority;
  readonly type: WorkItemType;
}

/** How much of each input the decision model sees. */
export const TRIAGE_LIMITS = {
  bodyCharacters: 12_000,
  candidates: 10,
  labelDescriptionCharacters: 200,
  labels: 40,
  maxAppliedLabels: 3,
  titleCharacters: 300,
} as const;

/**
 * Probability floors for acting on a yes/no answer.
 *
 * @remarks
 * Labels and duplicates are deliberately harder to earn than the routing
 * flags: a missing label costs a maintainer a click, while a wrong
 * "duplicate" closes the door on a real report.
 */
export const TRIAGE_THRESHOLDS = {
  actionable: 0.5,
  clarification: 0.6,
  duplicate: 0.85,
  label: 0.7,
  research: 0.6,
} as const;

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;

const TYPE_CRITERIA = {
  bug: "Something that exists behaves incorrectly, crashes, or regressed.",
  chore:
    "Maintenance with no behavior change for users: dependencies, CI, tooling, docs.",
  feature: "New behavior or capability that does not exist yet.",
  question:
    "Asks how something works or whether something is possible; requests no change.",
  refactor: "Restructures existing code without changing what it does.",
  security:
    "A vulnerability, a leaked secret, or a missing authorization or validation check.",
} as const satisfies Record<WorkItemType, string>;

const PRIORITY_CRITERIA = {
  critical:
    "Production is down, data is being lost or exposed, or a security hole is exploitable now.",
  high: "A core flow is broken or blocked for many users, with no reasonable workaround.",
  low: "Cosmetic, nice to have, or affects very few users.",
  medium:
    "Real impact, but a workaround exists or only some users are affected.",
} as const satisfies Record<Priority, string>;

const COMPLEXITY_CRITERIA = {
  large:
    "Cross-cutting work across several modules, or a design decision is needed first.",
  medium: "Several files in one area, with tests to add or update.",
  small: "One file or one function, with an obvious place to make the change.",
  trivial: "A one-line or copy change: a typo, a constant, a config value.",
} as const satisfies Record<Complexity, string>;

const coreQuestions = {
  actionable: {
    criteria: {
      false:
        "Key facts are missing: what to change, where, or what the expected result is.",
      true: "A competent engineer could start work from this text alone.",
    },
    instructions:
      "Does the work item contain enough information to act on without asking anyone?",
    type: "boolean",
  },
  complexity: {
    criteria: COMPLEXITY_CRITERIA,
    instructions: "Estimate the size of the change the work item calls for.",
    type: "choice",
  },
  needs_clarification: {
    criteria: {
      false: "The intent is clear, even if some details must be assumed.",
      true: "The request is ambiguous or self-contradictory enough that building it now risks building the wrong thing entirely.",
    },
    instructions:
      "Would proceeding without asking the requester a question risk building the wrong thing?",
    type: "boolean",
  },
  needs_research: {
    criteria: {
      false:
        "Everything needed is in the work item or would be in the repository.",
      true: "It turns on an outside fact: an upstream bug, a library version or changelog, a standard, or a claim that must be verified on the web.",
    },
    instructions:
      "Does resolving this work item depend on a fact that neither the item nor the repository would hold?",
    type: "boolean",
  },
  priority: {
    criteria: PRIORITY_CRITERIA,
    instructions: "Judge how urgent the work item is from its stated impact.",
    type: "choice",
  },
  type: {
    criteria: TYPE_CRITERIA,
    instructions: "Classify the kind of work the item asks for.",
    type: "choice",
  },
} as const satisfies Record<string, DecisionQuestion>;

const labelKey = (index: number): string => `label_${index}`;
const duplicateKey = (index: number): string => `duplicate_${index}`;

/**
 * Builds the full question set for one work item.
 *
 * @remarks
 * Label and duplicate questions are keyed by position, never by the label
 * name or issue title, so repository-controlled text can't collide with a
 * core question's key. Label names and descriptions appear in the question
 * text because only people with triage rights on the repository can write
 * them; issue titles, which anyone can write, do not.
 */
const buildTriageQuestions = (
  labels: readonly RepoLabel[],
  candidates: readonly DuplicateCandidate[]
): Record<string, DecisionQuestion> => {
  const questions: Record<string, DecisionQuestion> = { ...coreQuestions };
  labels.slice(0, TRIAGE_LIMITS.labels).forEach((label, index) => {
    const description = label.description?.trim();
    questions[labelKey(index)] = {
      instructions: `Should the existing repository label "${label.name}"${
        description
          ? ` (${clip(description, TRIAGE_LIMITS.labelDescriptionCharacters)})`
          : ""
      } be applied to this work item? Answer yes only when the label clearly describes it.`,
      type: "boolean",
    };
  });
  candidates.slice(0, TRIAGE_LIMITS.candidates).forEach((candidate, index) => {
    questions[duplicateKey(index)] = {
      // The candidate's title is in the state, not here. Anyone can file an
      // issue, so a title is untrusted text, and a question's instructions
      // are the one place the decision model takes direction from.
      instructions: `Does the work item (title and body in the state) report the same underlying problem or request as the existing issue #${candidate.number}, listed at index ${index} of existing_issues in the state? Answer yes only when resolving one would fully resolve the other.`,
      type: "boolean",
    };
  });
  return questions;
};

type Answers = Readonly<Record<string, unknown>>;

const choiceOf = <T extends string>(
  answers: Answers,
  key: string,
  allowed: readonly T[],
  fallback: T
): { choice: T; confidence: number | null } => {
  const answer = answers[key] as
    | { choice?: unknown; probabilities?: Record<string, unknown> }
    | undefined;
  const choice = allowed.find((value) => value === answer?.choice);
  if (choice === undefined) {
    return { choice: fallback, confidence: null };
  }
  const probability = answer?.probabilities?.[choice];
  return {
    choice,
    confidence: typeof probability === "number" ? probability : null,
  };
};

const probabilityOf = (answers: Answers, key: string): number => {
  const answer = answers[key] as { probability?: unknown } | undefined;
  return typeof answer?.probability === "number" ? answer.probability : 0;
};

/**
 * Picks the lane from the answers. Pure, so the routing rules are testable
 * on their own.
 */
const laneFor = (triage: {
  readonly actionable: boolean;
  readonly duplicates: readonly number[];
  readonly needs_clarification: boolean;
  readonly type: WorkItemType;
}): TriageLane => {
  if (triage.duplicates.length > 0) {
    return "duplicate";
  }
  if (triage.needs_clarification || !triage.actionable) {
    return "clarify";
  }
  return triage.type === "question" ? "answer" : "pipeline";
};

/**
 * Classifies a work item, selects its labels, and checks it against likely
 * duplicates, in one decision-model call.
 *
 * @param item - The work item, verbatim. Treated as untrusted data.
 * @param labels - The repository's label vocabulary; only these can come back.
 * @param candidates - Existing issues that might be the same report.
 */
export const triageWorkItem = async (
  item: WorkItem,
  labels: readonly RepoLabel[],
  candidates: readonly DuplicateCandidate[],
  dependencies: TriageDependencies
): Promise<Triage> => {
  const usedLabels = labels.slice(0, TRIAGE_LIMITS.labels);
  const usedCandidates = candidates.slice(0, TRIAGE_LIMITS.candidates);
  const result = await decide({
    model: MODELS.decision,
    questions: buildTriageQuestions(usedLabels, usedCandidates),
    signal: dependencies.signal,
    state: {
      body: clip(item.body, TRIAGE_LIMITS.bodyCharacters),
      existing_issues: usedCandidates.map((candidate, index) => ({
        index,
        number: candidate.number,
        title: clip(candidate.title, TRIAGE_LIMITS.titleCharacters),
      })),
      title: clip(item.title, TRIAGE_LIMITS.titleCharacters),
    },
  });
  const answers = result.answers as Answers;

  const type = choiceOf(answers, "type", WORK_ITEM_TYPES, "chore");
  const priority = choiceOf(answers, "priority", PRIORITIES, "medium");
  const complexity = choiceOf(answers, "complexity", COMPLEXITIES, "medium");

  const selectedLabels = usedLabels
    .map((label, index) => ({
      name: label.name,
      probability: probabilityOf(answers, labelKey(index)),
    }))
    .filter((label) => label.probability >= TRIAGE_THRESHOLDS.label)
    .sort((a, b) => b.probability - a.probability)
    .slice(0, TRIAGE_LIMITS.maxAppliedLabels)
    .map((label) => label.name);

  const duplicates = usedCandidates
    .map((candidate, index) => ({
      number: candidate.number,
      probability: probabilityOf(answers, duplicateKey(index)),
    }))
    .filter((candidate) => candidate.probability >= TRIAGE_THRESHOLDS.duplicate)
    .sort((a, b) => b.probability - a.probability)
    .map((candidate) => candidate.number);

  const flags = {
    actionable:
      probabilityOf(answers, "actionable") >= TRIAGE_THRESHOLDS.actionable,
    needs_clarification:
      probabilityOf(answers, "needs_clarification") >=
      TRIAGE_THRESHOLDS.clarification,
    needs_research:
      probabilityOf(answers, "needs_research") >= TRIAGE_THRESHOLDS.research,
  };

  return {
    ...flags,
    complexity: complexity.choice,
    confidence: {
      complexity: complexity.confidence,
      priority: priority.confidence,
      type: type.confidence,
    },
    duplicates,
    labels: selectedLabels,
    lane: laneFor({ ...flags, duplicates, type: type.choice }),
    priority: priority.choice,
    type: type.choice,
  };
};

export const CI_FAILURE_CAUSES = [
  "code",
  "flaky",
  "infrastructure",
  "configuration",
] as const;
export type CiFailureCause = (typeof CI_FAILURE_CAUSES)[number];

export const CI_LOG_CHARACTERS = 16_000;

const CI_CAUSE_CRITERIA = {
  code: "A test, type check, lint rule, or build step failed because of what the branch changed. Fixing the code fixes the run.",
  configuration:
    "The workflow itself is wrong or missing something: a secret, a permission, a required variable, a broken workflow file.",
  flaky:
    "A test that is known to be timing- or order-dependent failed in a way unrelated to the change; a rerun would likely pass.",
  infrastructure:
    "The runner or a service it depends on failed: network errors, registry or download failures, out of disk, a cancelled or timed-out runner.",
} as const satisfies Record<CiFailureCause, string>;

export interface CiDiagnosis {
  readonly cause: CiFailureCause;
  readonly confidence: number | null;
  /** True only when changing the branch's code is the right response. */
  readonly fix_with_code: boolean;
}

/**
 * Sorts a failed CI run by cause, so the fix loop only spends an
 * implementer and reviewer cycle on failures that code can fix.
 *
 * @param log - The failed jobs' log output; the tail is what gets judged.
 */
export const diagnoseCiFailure = async (
  log: string,
  dependencies: TriageDependencies
): Promise<CiDiagnosis> => {
  const tail =
    log.length > CI_LOG_CHARACTERS ? log.slice(-CI_LOG_CHARACTERS) : log;
  const result = await decide({
    model: MODELS.decision,
    questions: {
      cause: {
        criteria: CI_CAUSE_CRITERIA,
        instructions:
          "From this failed CI log, decide what kind of failure it is.",
        type: "choice",
      },
    },
    signal: dependencies.signal,
    state: { failed_job_log: tail },
  });
  const cause = choiceOf(
    result.answers as Answers,
    "cause",
    CI_FAILURE_CAUSES,
    "code"
  );
  return {
    cause: cause.choice,
    confidence: cause.confidence,
    fix_with_code: cause.choice === "code",
  };
};
