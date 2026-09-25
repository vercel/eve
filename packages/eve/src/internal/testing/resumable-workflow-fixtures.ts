/**
 * Resumable workflow tool bodies, and a stand-in owner inbox, for the
 * resumable-run integration test. Each body is the stub the test tier's
 * client transform produces; the run registers the real one.
 */

import { createHook, sleep as workflowSleep } from "#compiled/@workflow/core/index.js";

import type {
  WorkflowToolContext,
  ResumableWorkflowToolContext,
} from "#tools/workflow-definition.js";

interface NotesInput {
  readonly request: string;
}

type NotesContext = ResumableWorkflowToolContext<NotesInput, unknown>;

/**
 * Drafts notes, then revises them on each send; a "close" send ends the task
 * with its own result. Each result names the call whose generation it settles.
 */
export async function resumableNotesWorkflow(input: NotesInput, ctx: WorkflowToolContext) {
  "use workflow";
  const task = ctx as NotesContext;
  let notes = await reviseStep("", input.request);
  for (;;) {
    task.reply(`${notes} @${task.callId}`);
    const next = await task.receive();
    if (next.request === "close") return `closed after ${notes} @${task.callId}`;
    notes = await reviseStep(notes, next.request);
  }
}

/**
 * Reads a send before its first reply (the send joins generation 1), shows a
 * second reply throws, then returns without reading the last send.
 */
export async function resumableEdgesWorkflow(
  input: NotesInput & { readonly gate: string; readonly gate2: string },
  ctx: WorkflowToolContext,
) {
  "use workflow";
  const task = ctx as NotesContext;
  await createHook<void>({ token: input.gate });
  // The send landed before this read, so it is queued and joins this generation.
  const correction = await Promise.race([
    task.receive(),
    workflowSleep("2s").then(() => undefined),
  ]);
  task.reply(`draft ${input.request} + ${correction?.request ?? "none"}`);
  let secondReply = "no error";
  try {
    task.reply("again");
  } catch (error) {
    secondReply = error instanceof Error ? error.message : String(error);
  }
  const next = await task.receive();
  task.reply({ next: next.request, secondReply });
  await createHook<void>({ token: input.gate2 });
  return undefined;
}

/** Stops its current generation on cancel and goes back to reading; the task stays alive. */
export async function resumableCancelWorkflow(input: NotesInput, ctx: WorkflowToolContext) {
  "use workflow";
  const task = ctx as NotesContext;
  let request = input.request;
  for (;;) {
    try {
      await untilAborted(task.abortSignal);
    } catch {
      // Cancelled: leave this generation and wait for the next input.
    }
    const next = await task.receive();
    request = next.request;
    task.reply(`working on ${request}`);
    await task.receive();
  }
}

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function reviseStep(notes: string, request: string): Promise<string> {
  "use step";
  return notes === "" ? `notes(${request})` : `${notes}>${request}`;
}

/** Stands in for the owner session's inbox: records every run message for the test process. */
export async function resumableOwnerProbeWorkflow(input: { readonly token: string }) {
  "use workflow";
  const inbox = createHook<{ readonly kind?: string }>({ token: input.token });
  for await (const message of inbox) {
    await recordOwnerMessageStep(input.token, message);
    if (message.kind === "ended" || message.kind === "outcome") return;
  }
}

async function recordOwnerMessageStep(token: string, message: unknown): Promise<void> {
  "use step";
  const store = ((globalThis as { __resumableRuns?: Record<string, unknown[]> }).__resumableRuns ??=
    {});
  (store[token] ??= []).push(message);
}
