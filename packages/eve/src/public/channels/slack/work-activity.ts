import type { WorkAction, WorkGraph, WorkPhase } from "#harness/work-graph.js";

const ACTIVITY_MESSAGE_MAX_ITEMS = 8;

type SlackBlock = Record<string, unknown>;

export interface SlackWorkActivityState {
  workActivityMessageTs?: string | null;
  workActivityTurnId?: string | null;
}

export interface SlackWorkActivityChannel {
  readonly slack: {
    readonly channelId: string;
    request(
      operation: "chat.delete",
      body: { readonly channel: string; readonly ts: string },
    ): Promise<{ readonly error?: string; readonly ok: boolean }>;
    request(
      operation: "chat.update",
      body: {
        readonly blocks: readonly SlackBlock[];
        readonly channel: string;
        readonly text: string;
        readonly ts: string;
      },
    ): Promise<{ readonly error?: string; readonly ok: boolean }>;
  };
  readonly state: SlackWorkActivityState;
  readonly thread: {
    post(message: { readonly blocks: readonly SlackBlock[]; readonly text: string }): Promise<{
      readonly id: string;
    }>;
  };
}

/** Removes the transient activity card once the parent turn reaches a terminal event. */
export async function settleSlackWorkActivity(channel: SlackWorkActivityChannel): Promise<void> {
  const ts = channel.state.workActivityMessageTs;
  if (!ts) return;
  try {
    await channel.slack.request("chat.delete", {
      channel: channel.slack.channelId,
      ts,
    });
    channel.state.workActivityMessageTs = null;
    channel.state.workActivityTurnId = null;
  } catch {
    // Activity rendering is cosmetic.
  }
}

export async function renderSlackWorkActivity(input: {
  readonly allowPost?: boolean;
  readonly channel: SlackWorkActivityChannel;
  readonly work: WorkGraph | undefined;
}): Promise<void> {
  const turn = input.work?.turn;
  if (turn === undefined) return;
  const activity = renderWorkActivity({
    actions: turn.steps.flatMap((step) => step.actions),
    blockers: turn.blockers,
  });
  if (activity === undefined) return;

  const currentTs =
    input.channel.state.workActivityTurnId === turn.id
      ? input.channel.state.workActivityMessageTs
      : undefined;
  if (currentTs) {
    try {
      const response = await input.channel.slack.request("chat.update", {
        channel: input.channel.slack.channelId,
        blocks: activity.blocks,
        text: activity.text,
        ts: currentTs,
      });
      if (response.ok === true) return;
      if (response.error !== "message_not_found") return;
    } catch {
      return;
    }
  }

  if (input.allowPost === false) return;

  try {
    const posted = await input.channel.thread.post({
      blocks: activity.blocks,
      text: activity.text,
    });
    if (posted.id) {
      input.channel.state.workActivityMessageTs = posted.id;
      input.channel.state.workActivityTurnId = turn.id;
    }
  } catch {
    // Activity rendering is cosmetic.
  }
}

function renderWorkActivity(input: {
  readonly actions: readonly WorkAction[];
  readonly blockers: readonly { kind: string; label?: string; phase: string }[];
}): { readonly blocks: readonly SlackBlock[]; readonly text: string } | undefined {
  const blockers = input.blockers
    .filter((blocker) => blocker.phase === "blocked")
    .map((blocker) => {
      const text = `! ${blocker.label ?? `Waiting for ${blocker.kind}`}`;
      return { markdown: text, text };
    });
  const actions = input.actions
    .filter((action) => action.phase !== "queued")
    .slice(-ACTIVITY_MESSAGE_MAX_ITEMS - blockers.length);
  const rows = [...blockers, ...actions.map(renderAction)];
  if (rows.length === 0) return undefined;
  const text = ["Working", ...rows.map((row) => row.text)].join("\n");
  return {
    blocks: actions.map(workTaskCard),
    text,
  };
}

function renderAction(action: WorkAction): { readonly markdown: string; readonly text: string } {
  const child = action.child?.work?.turn;
  if (child === undefined) {
    const text = `${phaseGlyph(action.phase)} ${action.name}`;
    return { markdown: text, text };
  }
  const childActions = child.steps.flatMap((step) => step.actions);
  const childRows = childActions.map((childAction) => {
    const text = `${phaseGlyph(childAction.phase)} ${childAction.detail ?? childAction.name}`;
    return { markdown: `   ${text}`, text };
  });
  const text = `${phaseGlyph(action.phase)} ${action.name}`;
  return {
    markdown: [
      `${phaseGlyph(action.phase)} *${action.name}*`,
      ...childRows.map((row) => row.markdown),
    ].join("\n"),
    text: [text, ...childRows.map((row) => `  ${row.text}`)].join("\n"),
  };
}

function workTaskCard(action: WorkAction, index: number): SlackBlock {
  const childActions = action.child?.work?.turn?.steps.flatMap((step) => step.actions) ?? [];
  const details = childActions
    .map((child) => `${phaseGlyph(child.phase)} ${child.detail ?? child.name}`)
    .join("\n");
  return {
    status: planTaskStatus(action.phase),
    task_id: `work-${index}`,
    title: action.name,
    type: "task_card",
    ...(details === "" ? {} : { details: richText(details) }),
  };
}

function richText(text: string): SlackBlock {
  const lines = text.split("\n");
  const elements = lines.flatMap((line, index) => {
    const [glyph, ...rest] = line.split(" ");
    return [
      { style: { bold: true }, text: glyph, type: "text" },
      { text: ` ${rest.join(" ")}${index === lines.length - 1 ? "" : "\n"}`, type: "text" },
    ];
  });
  return {
    elements: [{ elements, type: "rich_text_section" }],
    type: "rich_text",
  };
}

function planTaskStatus(phase: WorkPhase): "complete" | "error" | "in_progress" | "pending" {
  switch (phase) {
    case "completed":
      return "complete";
    case "cancelled":
    case "failed":
      return "error";
    case "blocked":
    case "queued":
      return "pending";
    case "running":
      return "in_progress";
  }
}

function phaseGlyph(phase: WorkPhase): string {
  switch (phase) {
    case "blocked":
      return "!";
    case "cancelled":
      return "⊘";
    case "completed":
      return "✓";
    case "failed":
      return "✕";
    case "queued":
      return "○";
    case "running":
      return "◐";
  }
}
