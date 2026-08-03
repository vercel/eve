import { z } from "zod";

const FILE_PATH_SCHEMA = z
  .string()
  .describe("Absolute path under /source for the file being changed.");

export const EDIT_SCHEMA = z.discriminatedUnion("kind", [
  z.strictObject({
    content: z.string().describe("Complete contents for the new file."),
    filePath: FILE_PATH_SCHEMA,
    kind: z.literal("create"),
  }),
  z.strictObject({
    filePath: FILE_PATH_SCHEMA,
    kind: z.literal("replace"),
    newText: z.string().describe("Replacement text."),
    oldText: z.string().min(1).describe("Existing text that must occur exactly once."),
  }),
  z.strictObject({
    filePath: FILE_PATH_SCHEMA,
    kind: z.literal("delete"),
  }),
]);

export const PROPOSE_EDITS_INPUT_SCHEMA = z.strictObject({
  edits: z.array(EDIT_SCHEMA).min(1).describe("The complete set of proposed source edits."),
  summary: z.string().min(1).describe("A concise explanation of the proposed change."),
});

export const PROPOSAL_REFERENCE_SCHEMA = z.strictObject({
  proposalId: z.string().uuid(),
});

export const FINALIZE_EDITS_OUTPUT_SCHEMA = z.strictObject({
  changedFiles: z.array(z.string()),
  proposalId: z.string().uuid(),
});

export type ProposalInput = z.infer<typeof PROPOSE_EDITS_INPUT_SCHEMA>;
export type ProposalReference = z.infer<typeof PROPOSAL_REFERENCE_SCHEMA>;
export type FinalizeEditsOutput = z.infer<typeof FINALIZE_EDITS_OUTPUT_SCHEMA>;
