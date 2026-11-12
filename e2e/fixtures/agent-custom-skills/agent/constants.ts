/** The always-on skill's marker, which the model echoes only while the skill applies. */
export const PERSONA_MARKER = "PERSONA-E2E-R4V8";
export const PERSONA = {
  applicationMode: "always",
  description: "Sign every reply.",
  instructions: `End every reply with ${PERSONA_MARKER}.`,
  name: "sign-off",
} as const;

/** The on-demand skill's two versions, told apart by their descriptions. */
export const CHECKLIST_V1 = "Use when the user asks for the release checklist.";
export const CHECKLIST_V2 = "Use when the user asks for the release checklist, version two.";
export const CHECKLIST = {
  applicationMode: "on-demand",
  description: CHECKLIST_V1,
  instructions: "Check the build, then the changelog.",
  name: "release-checklist",
} as const;
