import type {
  Client,
  ClientSession,
  InputRequest,
  InputResponse,
  MessageResponse,
  MessageStreamEvent,
} from "eve/client";
import { VOICE_CLIENT_CONTEXT } from "./voice-config";

/** GPT-Live-1 context channels: `thinking` is silent, `commentary` is spoken. */
export type LiveContextChannel = "commentary" | "thinking";

export type DelegationStatus = "running" | "needs-input" | "done" | "failed";

export type Delegation = {
  readonly id: string;
  readonly request: string;
  readonly status: DelegationStatus;
  readonly steps: readonly string[];
  readonly answer?: string;
  readonly inputRequests?: readonly InputRequest[];
};

type Job = { delegation: Delegation; response?: MessageResponse };

// GPT-Live-1 rejects context appends over 500 tokens.
const MAX_APPEND_CHARS = 1500;

/**
 * Runs GPT-Live-1 delegations through one durable eve session per call.
 *
 * Delegations run one at a time so each answer can be matched to the
 * delegation that asked for it. Approvals pause a delegation until the user
 * answers on screen; the voice model is never allowed to approve anything.
 */
export class VoiceDelegate {
  private session: ClientSession | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly jobs = new Map<string, Job>();
  private disposed = false;

  constructor(
    private readonly options: {
      readonly client: Client;
      readonly appendContext: (
        delegationId: string,
        channel: LiveContextChannel,
        content: string,
      ) => Promise<void>;
      readonly onChange: (delegations: readonly Delegation[]) => void;
    },
  ) {}

  delegate(id: string, request: string): void {
    this.track({ delegation: { id, request, status: "running", steps: [] } });
    this.enqueue(id, () => this.send(id, request));
  }

  respond(id: string, responses: readonly InputResponse[]): void {
    const job = this.jobs.get(id);
    if (!job || job.delegation.status !== "needs-input" || !this.session) return;

    const session = this.session;
    this.update(id, { inputRequests: undefined, status: "running" });
    this.enqueue(id, async () => this.consume(id, await session.respond(responses)));
  }

  /** Stops in-flight eve turns. Closing the call alone would leave them running. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled(
      [...this.jobs.values()]
        .filter((job) => job.delegation.status === "running" && job.response)
        .map((job) => job.response!.cancel()),
    );
  }

  private enqueue(id: string, task: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      if (this.disposed) return;
      try {
        await task();
      } catch (error) {
        console.error("eve delegation failed", error);
        this.update(id, { status: "failed" });
        await this.speak(id, "Something went wrong while the agent was working on that.");
      }
    });
  }

  private async send(id: string, request: string): Promise<void> {
    const turn = { clientContext: VOICE_CLIENT_CONTEXT };

    if (this.session) {
      await this.consume(id, await this.session.send(request, turn));
      return;
    }

    const { response, session } = await this.options.client.sessions.create({
      ...turn,
      message: request,
    });
    this.session = session;
    await this.consume(id, response);
  }

  private async consume(id: string, response: MessageResponse): Promise<void> {
    const job = this.jobs.get(id)!;
    job.response = response;
    let answer: string | undefined;
    let inputRequests: readonly InputRequest[] | undefined;
    let failed = false;

    // Read to the turn boundary even after a pause or failure so the session
    // cursor lands where the next send or respond expects it.
    for await (const event of response) {
      const step = describeStep(event);
      if (step) {
        this.update(id, { steps: [...job.delegation.steps, step] });
        await this.append(id, "thinking", `The agent is ${step.toLowerCase()}.`);
      }

      if (event.type === "message.completed" && event.data.finishReason !== "tool-calls") {
        answer = event.data.message;
      } else if (event.type === "input.requested") {
        inputRequests = event.data.requests;
      } else if (event.type === "turn.failed" || event.type === "session.failed") {
        failed = true;
      }
    }
    job.response = undefined;

    if (failed) {
      this.update(id, { status: "failed" });
      await this.speak(id, "The agent could not finish that request.");
    } else if (inputRequests) {
      this.update(id, { inputRequests, status: "needs-input" });
      const prompts = inputRequests.map((request) => request.prompt).join(" ");
      await this.speak(id, `The agent needs the user to answer on screen: ${prompts}`);
    } else {
      this.update(id, { answer, status: "done" });
      await this.speak(id, answer?.trim() || "The agent finished without a reply.");
    }
  }

  private speak(id: string, content: string): Promise<void> {
    return this.append(id, "commentary", content);
  }

  private async append(id: string, channel: LiveContextChannel, content: string): Promise<void> {
    if (this.disposed) return;
    await this.options.appendContext(id, channel, truncate(content));
  }

  private track(job: Job): void {
    this.jobs.set(job.delegation.id, job);
    this.emit();
  }

  private update(id: string, patch: Partial<Delegation>): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.delegation = { ...job.delegation, ...patch };
    this.emit();
  }

  private emit(): void {
    this.options.onChange([...this.jobs.values()].map((job) => job.delegation));
  }
}

function describeStep(event: MessageStreamEvent): string | undefined {
  if (event.type !== "actions.requested") return undefined;

  const names = event.data.actions.map(
    (action) =>
      event.data.presentation?.[action.callId]?.label ??
      ("toolName" in action ? action.toolName : action.name),
  );
  return `Running ${names.join(", ")}`;
}

function truncate(text: string): string {
  return text.length <= MAX_APPEND_CHARS ? text : `${text.slice(0, MAX_APPEND_CHARS - 1)}…`;
}
