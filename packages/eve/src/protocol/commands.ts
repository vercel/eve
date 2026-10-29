/** One slash command an eve channel offers, as `GET /eve/v1/commands` lists it. */
export interface CommandInfo {
  readonly name: string;
  readonly description: string;
  /** Whether text may follow the name. Clients match a `"none"` command only when it's typed alone. */
  readonly arguments: "none" | "text";
  /** Argument shape to display after the name. */
  readonly argumentHint?: string;
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
