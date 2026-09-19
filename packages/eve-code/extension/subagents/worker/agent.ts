import { defineAgent } from "eve";

import { WORKER_DEFAULTS } from "../../extension.ts";

export default defineAgent({
  description:
    "Another mind for one scoped slice. Give it a self-contained question and choose the lifetime: keep it and send deltas when it should own the slice end to end, or ask once. It can see the shared tree. You remain the arbiter and keep the writes.",
  ...WORKER_DEFAULTS,
  defaultTools: false,
});
