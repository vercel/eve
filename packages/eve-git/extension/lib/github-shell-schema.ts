import { z } from "zod";

export const githubShellInputSchema = z.object({
  command: z.string().trim().min(1).max(20_000),
  repository: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9._-]+)?$/u)
    .optional()
    .describe(
      "the owner/name repository the command acts on, or an owner for discovery such as gh repo list <owner>; omit for commands tied to no owner",
    ),
  description: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("the concrete GitHub-side result expected from this command"),
  workingDirectory: z
    .string()
    .trim()
    .min(1)
    .max(1_000)
    .optional()
    .describe("sandbox workspace directory; defaults to the workspace root"),
});
