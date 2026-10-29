/** Session controls a command applied, reported so a client can mirror them; `end` retires the session. */
export type CommandControl = "cancel" | "clear" | "compact" | "end";

/** One slash command an eve channel offers, as `GET /eve/v1/commands` lists it. */
export interface CommandInfo {
  readonly name: string;
  readonly description: string;
  /** Argument shape. A command without one takes no argument, so clients match it only alone. */
  readonly argumentHint?: string;
  readonly aliases?: readonly string[];
  /** `"required"` commands run only inside a session. */
  readonly session: "optional" | "required";
}

/** What running a command returns over `POST .../commands/:name`. */
export interface CommandRunResult {
  /** Text to show the caller. */
  readonly message?: string;
  /** Text to submit as the caller's next message. */
  readonly send?: string;
  readonly controls?: readonly CommandControl[];
}
