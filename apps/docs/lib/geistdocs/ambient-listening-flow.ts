export type AmbientBranch = {
  /** The check or condition at this step. */
  readonly label: string;
  /** Where this check lives in code, such as a hook or option. */
  readonly where?: string;
  /** What happens when this branch is taken. A step with children has none. */
  readonly result?: string;
  /** Renders the result as code, such as a tool name. */
  readonly code?: boolean;
  readonly children?: readonly AmbientBranch[];
};

export const ambientListeningRoot = "Slack message without a mention";

export const ambientListeningFlow: readonly AmbientBranch[] = [
  {
    label: "Not in a followed thread or watched channel",
    where: "onMessage",
    result: "ignored",
  },
  {
    label: "Decision model: clearly not for the agent?",
    where: "decide",
    result: "skipped, no turn",
  },
  {
    label: "Agent's model, with guidance and goals",
    where: 'status: "deferred"',
    children: [
      { label: "A reply is warranted", result: "answers in the thread" },
      { label: "It isn't", result: "no_reply", code: true },
    ],
  },
];

function renderBranch(branch: AmbientBranch, depth: number): string[] {
  const indent = "  ".repeat(depth);
  const where = branch.where ? ` (\`${branch.where}\`)` : "";
  const result = branch.result ? `: ${branch.code ? `\`${branch.result}\`` : branch.result}` : "";
  return [
    `${indent}- ${branch.label}${where}${result}`,
    ...(branch.children ?? []).flatMap((child) => renderBranch(child, depth + 1)),
  ];
}

export function renderAmbientListeningFlowMarkdown(): string {
  return [
    `${ambientListeningRoot}:`,
    "",
    ...ambientListeningFlow.flatMap((branch) => renderBranch(branch, 0)),
  ].join("\n");
}
