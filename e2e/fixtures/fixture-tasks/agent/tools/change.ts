import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

const draft = defineState("tasks.draft", () => ({ revision: 1, validatedRevision: 0 }));

export default defineTool({
  description: "Repair, validate, or publish the sample draft. A repair changes its revision.",
  inputSchema: z.strictObject({ action: z.enum(["repair", "validate", "publish"]) }),
  execute({ action }) {
    const { revision, validatedRevision } = draft.get();
    if (action === "repair") {
      draft.update((state) => ({ ...state, revision: revision + 1 }));
      return { revision: revision + 1 };
    }
    if (action === "validate") {
      draft.update((state) => ({ ...state, validatedRevision: revision }));
      return { revision, passed: true };
    }
    if (validatedRevision !== revision) {
      throw new Error("The current draft revision has not passed validation.");
    }
    return { revision, artifactId: `draft-${revision}` };
  },
});
