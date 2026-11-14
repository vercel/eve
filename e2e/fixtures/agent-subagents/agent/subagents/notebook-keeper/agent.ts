import { defineAgent } from "eve";
import { defineDynamic } from "eve/models";
import { mockModel } from "eve/evals";

import { respondAsNotebookKeeper } from "../../lib/notebook.js";

const keeperModel = mockModel({ modelId: "notebook-keeper", respond: respondAsNotebookKeeper });

/** The local notebook keeper; the remote one is `remote-loopback` running the same script. */
export default defineAgent({
  description:
    "Test fixture: keeps Alice's tide station notebook notes. Call it only for NOTEBOOK directives.",
  // The continuation evals reattach to a retired keeper and read its terminal events, which a
  // deployment without content tracing deletes when the run ends.
  experimental: { workflow: { retention: "default" } },
  // Selected per step: in mock mode this fixture replaces static authored
  // models with eve's bootstrap mock, which would drop the keeper's script.
  model: defineDynamic(() => ({ model: keeperModel, modelContextWindowTokens: 1_000_000 })),
});
