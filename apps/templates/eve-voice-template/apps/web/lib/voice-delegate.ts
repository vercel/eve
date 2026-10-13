import type { InputOption, InputRequest, MessageStreamEvent } from "eve/client";
import type { UseEveAgentHelpers } from "eve/react";
import { VOICE_CLIENT_CONTEXT } from "./voice-config";

/** GPT-Live-1 context channels: `thinking` is silent, `commentary` is spoken. */
export type LiveContextChannel = "commentary" | "thinking";

type Agent = Pick<UseEveAgentHelpers<unknown>, "cancel" | "respond" | "send">;

// GPT-Live-1 rejects context appends over 500 tokens.
const MAX_APPEND_CHARS = 1500;
// Speech wraps an answer in words a typed reply wouldn't have.
const FILLER = new Set(["it", "ok", "okay", "please", "that", "yeah", "yes"]);

/**
 * Relays GPT-Live-1 delegations to one eve session and the agent's progress
 * back into the call. The page renders the session itself; this class only
 * decides what the voice model hears.
 *
 * Delegations run one at a time so each answer reaches the delegation that
 * asked for it. A turn parked on input holds the queue, because eve treats a
 * message sent then as steering and would withdraw the prompt. Instead, what
 * the user says is checked against the first open prompt, the way eve answers
 * a typed reply that names an option. Anything else waits for the prompt.
 */
export class VoiceDelegate {
  private current: string | undefined;
  /** Whether the current turn's answer was already spoken. */
  private answered = false;
  private prompts: string[] = [];
  /** Open prompts in the order eve asked them; eve answers the first one first. */
  private open: InputRequest[] = [];
  private held = false;
  /** Whether the hook has no turn in flight, so a send starts a new turn. */
  private idle = true;
  private readonly queue: { readonly id: string; readonly request: string }[] = [];
  private disposed = false;

  constructor(
    private readonly options: {
      readonly agent: Agent;
      readonly appendContext: (
        delegationId: string,
        channel: LiveContextChannel,
        content: string,
      ) => Promise<void>;
    },
  ) {}

  /** Returns whether the request goes to eve as a message, rather than answering a prompt. */
  delegate(id: string, request: string): boolean {
    const prompt = this.held ? this.open[0] : undefined;
    const option = prompt && spokenOption(request, prompt);
    if (prompt && option) {
      this.open.shift();
      void this.options.agent.respond([{ optionId: option.id, requestId: prompt.requestId }]);
      this.speak(id, `The user's answer was recorded: ${option.label}.`);
      return false;
    }

    this.queue.push({ id, request });
    // Covers free-text questions and sign-ins too. The voice model never
    // guesses, so without this it goes quiet until the step on screen is done.
    if (this.held)
      this.speak(id, "The agent will get to this once the user finishes the step on screen.");
    this.drain();
    return true;
  }

  /** Call from the hook's `onFinish`, once its turn has fully settled. */
  settled(): void {
    this.idle = true;
    this.drain();
  }

  /** Forward every eve stream event here. */
  observe(event: MessageStreamEvent): void {
    const id = this.current;
    if (id === undefined || this.disposed) return;

    switch (event.type) {
      case "actions.requested": {
        const tools = event.data.actions.map(
          (action) =>
            event.data.presentation?.[action.callId]?.label ??
            ("toolName" in action ? action.toolName : action.name),
        );
        this.append(id, "thinking", `The agent is running ${tools.join(", ")}.`);
        return;
      }
      // The answer is final here; waiting for turn.completed only adds delay.
      case "message.completed":
        if (event.data.finishReason === "tool-calls" || !event.data.message.trim()) return;
        this.answered = true;
        this.speak(id, event.data.message.trim());
        return;
      case "input.requested":
        this.open.push(...event.data.requests);
        this.prompts.push(...event.data.requests.map((request) => request.prompt));
        return;
      case "input.resolved": {
        const resolved = new Set(event.data.resolutions.map((resolution) => resolution.requestId));
        this.open = this.open.filter((request) => !resolved.has(request.requestId));
        return;
      }
      case "turn.waiting": {
        if (event.data.on !== "input") return;
        this.held = true;
        const choices = (this.open[0]?.options ?? []).map((option) => option.label).join(" or ");
        this.speak(
          id,
          // A sign-in also parks the turn, without an input request.
          this.prompts.length === 0
            ? "The agent needs the user to finish a step on screen, such as signing in."
            : `The agent needs the user's answer: ${this.prompts.join(" ")} ` +
                (choices ? `The user can say ${choices}, or use the buttons on screen.` : ""),
        );
        this.prompts = [];
        return;
      }
      case "step.started":
        this.held = false;
        this.idle = false;
        return;
      case "turn.completed":
        if (!this.answered) this.speak(id, "The agent finished without a reply.");
        this.current = undefined;
        return;
      case "turn.failed":
        this.fail();
        return;
      case "turn.cancelled":
        this.current = undefined;
        return;
    }
  }

  /** Call when a send fails before eve streams anything back. */
  fail(): void {
    if (this.current === undefined || this.disposed) return;
    this.speak(this.current, "The agent could not finish that request.");
    this.current = undefined;
  }

  /** Stops the running eve turn. Closing the call alone would leave it running. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.queue.length = 0;
    if (this.current !== undefined && !this.held) {
      await this.options.agent.cancel().catch(() => {});
    }
  }

  // Sending while the hook's previous turn is still settling would steer it,
  // so the next delegation waits for `settled()`.
  private drain(): void {
    if (!this.idle || this.current !== undefined || this.disposed) return;
    const next = this.queue.shift();
    if (!next) return;

    this.current = next.id;
    this.answered = false;
    this.prompts = [];
    this.open = [];
    this.held = false;
    this.idle = false;
    // eve reports failures through the stream or the hook's onError.
    void this.options.agent.send(next.request, { clientContext: VOICE_CLIENT_CONTEXT });
  }

  private speak(id: string, content: string): void {
    this.append(id, "commentary", content);
  }

  private append(id: string, channel: LiveContextChannel, content: string): void {
    if (this.disposed) return;
    const text =
      content.length <= MAX_APPEND_CHARS ? content : `${content.slice(0, MAX_APPEND_CHARS - 1)}…`;
    void this.options.appendContext(id, channel, text).catch((error: unknown) => {
      console.error("Could not append context to the voice session", error);
    });
  }
}

/**
 * eve answers a typed reply that is exactly an option's id or label. Speech
 * adds punctuation and filler ("Approve it, please."), so those are dropped
 * first; anything else, such as "don't approve", is not an answer.
 */
function spokenOption(reply: string, prompt: InputRequest): InputOption | undefined {
  const words = reply.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  const answer = words.filter((word) => !FILLER.has(word)).join(" ");
  return prompt.options?.find(
    (option) => option.id.toLowerCase() === answer || option.label.toLowerCase() === answer,
  );
}
