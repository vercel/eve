import { defineToolStubs } from "eve/evals";

/** Stubs only `gate`, so a call to `read-status` fails the turn. */
export default defineToolStubs({
  tools: {
    gate: ({ marker }: { marker: string }) => ({ executed: true, marker, stubbed: true }),
  },
});
