// Structured-output JSON Schemas for the five stations, shared between each
// station's agent.ts (which needs none of this, now that outputSchema lives
// per-call) and its model-facing workflow-tool wrapper in agent/tools/,
// which passes one of these to ctx.agent(name, { message, outputSchema }).
// `as const` keeps the literal shape so the wrapper's return type is typed
// from the schema instead of widening to plain JSON.

export const CLASSIFIER_OUTPUT_SCHEMA = {
  additionalProperties: false,
  properties: {
    actionable: {
      description: "Whether the request contains enough information to act on.",
      type: "boolean",
    },
    affected_area: {
      description:
        "Best guess at the component, service, or layer involved (e.g. 'frontend/auth', 'API', 'CI pipeline', 'unknown').",
      type: "string",
    },
    complexity: {
      enum: ["trivial", "small", "medium", "large"],
      type: "string",
    },
    needs_clarification: {
      description:
        "True when the request is ambiguous, contradictory, or missing essential details; the questions to ask go in `questions`.",
      type: "boolean",
    },
    priority: {
      enum: ["critical", "high", "medium", "low"],
      type: "string",
    },
    questions: {
      description:
        "The specific clarifying questions to ask; empty unless needs_clarification is true.",
      items: { type: "string" },
      type: "array",
    },
    summary: {
      description: "One-sentence restatement of the work item.",
      type: "string",
    },
    type: {
      enum: ["bug", "feature", "refactor", "question", "chore", "security"],
      type: "string",
    },
  },
  required: [
    "type",
    "priority",
    "complexity",
    "affected_area",
    "actionable",
    "needs_clarification",
    "questions",
    "summary",
  ],
  type: "object",
} as const;

export const RESEARCHER_OUTPUT_SCHEMA = {
  additionalProperties: false,
  properties: {
    artifact_id: {
      description:
        "Id of the saved research-notes artifact holding the full memo, or null when none was saved.",
      type: ["string", "null"],
    },
    findings: {
      description:
        "One entry per verified factual claim; every entry carries at least one real source.",
      items: {
        additionalProperties: false,
        properties: {
          claim: {
            description:
              "A single, specific factual claim the caller can rely on.",
            type: "string",
          },
          confidence: {
            description:
              "'high' = multiple strong independent sources; 'low' = single or weaker source.",
            enum: ["high", "medium", "low"],
            type: "string",
          },
          notes: {
            description:
              "Caveats: date-sensitivity, scope limits, or where sources disagree.",
            type: "string",
          },
          sources: {
            description:
              "The real, fetched sources backing the claim; never empty, never invented.",
            items: {
              additionalProperties: false,
              properties: {
                title: {
                  description: "The source's title or publication name.",
                  type: "string",
                },
                url: {
                  description: "The source URL, as visited.",
                  type: "string",
                },
              },
              required: ["url", "title"],
              type: "object",
            },
            minItems: 1,
            type: "array",
          },
        },
        required: ["claim", "sources", "confidence", "notes"],
        type: "object",
      },
      type: "array",
    },
    gaps: {
      description:
        "What could not be found or verified; surfaced to the caller rather than guessed at.",
      items: { type: "string" },
      type: "array",
    },
    summary: {
      description:
        "A 1-3 sentence synthesis of what the research establishes, for the root to scan first.",
      type: "string",
    },
  },
  required: ["summary", "findings", "gaps", "artifact_id"],
  type: "object",
} as const;

export const ANALYST_OUTPUT_SCHEMA = {
  additionalProperties: false,
  properties: {
    acceptance_criteria: {
      description:
        "Objective, testable criteria the reviewer will check one by one, verbatim.",
      items: { type: "string" },
      minItems: 1,
      type: "array",
    },
    affected_surface: {
      description:
        "Files, modules, interfaces, or systems the change will touch; anything with a public contract called out.",
      items: { type: "string" },
      type: "array",
    },
    approach: {
      description:
        "The chosen solution strategy, and briefly the main alternative rejected and why.",
      type: "string",
    },
    artifact_id: {
      description:
        "Id of the saved analysis artifact holding the full supporting detail, or null when none was saved.",
      type: ["string", "null"],
    },
    assumptions: {
      description:
        "Assumptions the plan rests on, stated so the implementer and reviewer can see them.",
      items: { type: "string" },
      type: "array",
    },
    open_questions: {
      description:
        "External facts the plan could not resolve from the repository; surfaced instead of guessed.",
      items: { type: "string" },
      type: "array",
    },
    plan: {
      description:
        "Ordered, concrete steps; each independently verifiable. The smallest change that fully solves the problem.",
      items: { type: "string" },
      minItems: 1,
      type: "array",
    },
    problem_statement: {
      description:
        "What is actually wrong or wanted, restated as a precise engineering problem.",
      type: "string",
    },
    risks: {
      description:
        "What could break, edge cases, migration or compatibility concerns, and how the plan mitigates each.",
      items: { type: "string" },
      type: "array",
    },
    test_strategy: {
      description:
        "What should be tested and how (unit, integration, manual), grounded in the repository's own test setup.",
      type: "string",
    },
  },
  required: [
    "problem_statement",
    "approach",
    "plan",
    "affected_surface",
    "risks",
    "acceptance_criteria",
    "test_strategy",
    "assumptions",
    "open_questions",
    "artifact_id",
  ],
  type: "object",
} as const;

export const IMPLEMENTER_OUTPUT_SCHEMA = {
  additionalProperties: false,
  properties: {
    base: {
      description:
        "The branch the work is based on, normally the repository's default branch.",
      type: "string",
    },
    branch: {
      description: "The feature branch the work was committed and pushed to.",
      type: "string",
    },
    change_summary: {
      description: "What changed and why, per file.",
      items: {
        additionalProperties: false,
        properties: {
          change: {
            description: "What changed in this file and why.",
            type: "string",
          },
          path: { description: "The file path.", type: "string" },
        },
        required: ["path", "change"],
        type: "object",
      },
      type: "array",
    },
    deviations: {
      description:
        "Departures from the plan, each with its reason; empty when the plan held.",
      items: { type: "string" },
      type: "array",
    },
    known_limitations: {
      description: "Anything the reviewer should scrutinize.",
      items: { type: "string" },
      type: "array",
    },
    pushed: {
      description:
        "Whether push_branch succeeded; when false, the failure reason is in known_limitations.",
      type: "boolean",
    },
    verification: {
      description: "Commands run and what they produced, exactly.",
      items: {
        additionalProperties: false,
        properties: {
          command: { description: "The command as run.", type: "string" },
          result: {
            description: "What it produced: pass/fail and the relevant output.",
            type: "string",
          },
        },
        required: ["command", "result"],
        type: "object",
      },
      type: "array",
    },
  },
  required: [
    "branch",
    "base",
    "pushed",
    "change_summary",
    "verification",
    "deviations",
    "known_limitations",
  ],
  type: "object",
} as const;

export const REVIEWER_OUTPUT_SCHEMA = {
  additionalProperties: false,
  properties: {
    blocking_findings: {
      description:
        "Problems that block shipping: each names where it is, what is wrong, and why it matters.",
      items: { type: "string" },
      type: "array",
    },
    criteria_results: {
      description:
        "One entry per acceptance criterion from the analysis, judged individually.",
      items: {
        additionalProperties: false,
        properties: {
          criterion: {
            description: "The acceptance criterion, verbatim.",
            type: "string",
          },
          evidence: {
            description:
              "What in the diff or verification output shows it passing or failing.",
            type: "string",
          },
          pass: { type: "boolean" },
        },
        required: ["criterion", "pass", "evidence"],
        type: "object",
      },
      type: "array",
    },
    suggestions: {
      description: "Advisory notes that do not block shipping.",
      items: { type: "string" },
      type: "array",
    },
    summary: {
      description: "One paragraph: the verdict and what drove it.",
      type: "string",
    },
    verdict: {
      enum: ["approve", "request_changes", "reject"],
      type: "string",
    },
  },
  required: [
    "verdict",
    "criteria_results",
    "blocking_findings",
    "suggestions",
    "summary",
  ],
  type: "object",
} as const;
