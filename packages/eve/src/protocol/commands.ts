/** One slash command an eve channel offers, as `GET /eve/v1/commands` lists it. */
export interface CommandInfo {
  readonly name: string;
  readonly description: string;
  /** Text the command takes after its name. Without it, clients match the command only alone. */
  readonly input?: { readonly hint: string };
  readonly aliases?: readonly string[];
  /** `"required"` commands run only inside a session. */
  readonly session: "optional" | "required";
}

/** What running a command returns over `POST .../commands/:name`. */
export interface CommandRunResult {
  /** Text to show the caller. */
  readonly message?: string;
  /** The message the command sent into the session as the caller, to follow on its stream. */
  readonly delivery?: { readonly sessionId: string; readonly deliveryId: string };
  /** The command ended the session; the client's next message starts a new one. */
  readonly ended?: true;
}
