import { installComputerUse } from "eve/extensions/computer-use/sandbox";
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

/** The sandbox port the stage page is served on; Vercel gives it a public HTTPS domain. */
export const STAGE_PORT = 3000;

export const environment = VercelSandbox.environment({
  prepare: async (sandbox) => {
    await installComputerUse(sandbox);
  },
});

// Only meetings that present open a sandbox; the rest never start one. The
// desktop starts when the screen share or `computer_use` first needs it, so a
// slow start fails that call, not every use of the sandbox.
export default defineSandbox(() =>
  environment.open({
    ports: [STAGE_PORT],
    // Long enough for a meeting. The default 30 minutes would stop the shared screen mid-call.
    timeout: 2 * 60 * 60_000,
  }),
);
