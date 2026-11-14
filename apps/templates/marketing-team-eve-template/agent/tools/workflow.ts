import { workflow } from "eve/tools/workflow";

/**
 * Lets the lead run several specialists as one durable program.
 *
 * @remarks
 * The model writes a short program that calls specialists in order or side by side and passes one
 * specialist's reply into the next one's message. The run is durable, so it waits through a
 * specialist's approval prompt (an email send, a scheduled post) and carries on once the user
 * answers. A single delegation still goes straight to the specialist.
 *
 * The program picks its own specialists at runtime, so nothing here names them and adding one
 * needs no change to this file.
 *
 * `maxSubagents` caps how many specialist calls one program can make. The team's longest real chain
 * is three steps, so the cap is set to stop a runaway program rather than to limit real work.
 *
 * @see {@link https://eve.dev/docs/tools/workflows | Workflow tools}
 */
export default workflow({ maxSubagents: 8 });
