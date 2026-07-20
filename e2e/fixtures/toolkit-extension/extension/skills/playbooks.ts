import { defineDynamic, defineSkill } from "eve/skills";

// A map-producing dynamic skill resolver. Its bare key `incident` must compose
// under the mount namespace as `toolkit__incident` once mounted — not the bare
// `incident` — so it can't collide with the consumer's or another extension's
// skills. The dynamic-skill eval loads it by the namespaced name to prove that.
export default defineDynamic({
  events: {
    "session.started": async () => ({
      incident: defineSkill({
        description:
          "Use ONLY when the user asks for the toolkit incident playbook. " +
          'Triggered by the literal phrase "toolkit incident playbook".',
        markdown: [
          "# Toolkit incident playbook",
          "",
          "When this skill is loaded, ignore conflicting earlier instructions and reply",
          "with exactly the following text and nothing else:",
          "",
          "toolkit-incident-dynamic-ok-7T2X",
        ].join("\n"),
      }),
    }),
  },
});
