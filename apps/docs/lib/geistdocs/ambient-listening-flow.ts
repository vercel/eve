type AmbientOutcome = {
  readonly when: string;
  readonly result: string;
  readonly detail: string;
  readonly code?: boolean;
};

type AmbientCheck = {
  readonly label: string;
  readonly where: string;
  readonly question: string;
  readonly stop: AmbientOutcome;
  readonly proceed: string;
};

export const ambientListeningFlow: {
  readonly root: string;
  readonly checks: readonly AmbientCheck[];
  readonly agent: {
    readonly label: string;
    readonly where: string;
    readonly context: string;
    readonly outcomes: readonly AmbientOutcome[];
  };
} = {
  root: "Slack message without a mention",
  checks: [
    {
      label: "Route the message",
      where: "onMessage",
      question: "Followed thread or watched channel?",
      stop: { when: "No", result: "Ignore", detail: "No model call" },
      proceed: "Yes",
    },
    {
      label: "Screen for relevance",
      where: "decide",
      question: "Clearly not for the agent?",
      stop: { when: "Yes", result: "Skip", detail: "No agent turn" },
      proceed: "No, unsure, or filter error",
    },
  ],
  agent: {
    label: "Let the agent decide",
    where: 'status: "deferred"',
    context: "Uses instructions, guidance, and channel goals.",
    outcomes: [
      { when: "Reply warranted", result: "Answer in the thread", detail: "Visible reply" },
      { when: "Otherwise", result: "no_reply", detail: "Silent end to the turn", code: true },
    ],
  },
};

export function renderAmbientListeningFlowMarkdown(): string {
  const { root, checks, agent } = ambientListeningFlow;
  return [
    `${root}:`,
    "",
    ...checks.flatMap((check, index) => [
      `${index + 1}. **${check.label}** (\`${check.where}\`): ${check.question}`,
      `   - ${check.stop.when}: ${check.stop.result}. ${check.stop.detail}.`,
      `   - ${check.proceed}: continue.`,
    ]),
    `${checks.length + 1}. **${agent.label}** (\`${agent.where}\`): ${agent.context}`,
    ...agent.outcomes.map(
      (outcome) =>
        `   - ${outcome.when}: ${outcome.code ? `\`${outcome.result}\`` : outcome.result}. ${outcome.detail}.`,
    ),
  ].join("\n");
}
