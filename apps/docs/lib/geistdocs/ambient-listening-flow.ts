export type AmbientOutcome = {
  readonly when: string;
  readonly result: string;
  /** Renders the result as code, such as a tool name. */
  readonly code?: boolean;
};

export type AmbientStage = {
  readonly title: string;
  readonly where: string;
  readonly question: string;
  readonly stops: readonly AmbientOutcome[];
  /** What moves the message on to the next stage. The last stage has none. */
  readonly passes?: string;
};

export const ambientListeningFlow: readonly AmbientStage[] = [
  {
    title: "Free checks",
    where: "onMessage",
    question: "Is it in a followed thread or a watched channel?",
    stops: [{ when: "No", result: "Ignored" }],
    passes: "Yes",
  },
  {
    title: "Decision model",
    where: "decide",
    question: "Is it clearly not for the agent?",
    stops: [{ when: "Clearly not", result: "Skipped, no turn" }],
    passes: "Maybe, or unsure",
  },
  {
    title: "Agent",
    where: 'status: "deferred"',
    question: "Is a reply warranted?",
    stops: [
      { when: "Yes", result: "Replies in the thread" },
      { when: "No", result: "no_reply", code: true },
    ],
  },
];

export function renderAmbientListeningFlowMarkdown(): string {
  return ambientListeningFlow
    .map((stage, index) => {
      const outcomes = stage.stops.map(
        (stop) => `  - ${stop.when}: ${stop.code ? `\`${stop.result}\`` : stop.result}`,
      );
      const next = ambientListeningFlow[index + 1];
      const passes =
        stage.passes && next
          ? [`  - ${stage.passes}: continue to ${next.title.toLowerCase()}`]
          : [];
      return [
        `${index + 1}. **${stage.title}** (\`${stage.where}\`): ${stage.question}`,
        ...outcomes,
        ...passes,
      ].join("\n");
    })
    .join("\n");
}
