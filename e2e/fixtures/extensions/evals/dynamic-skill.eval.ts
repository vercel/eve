import { defineEval } from "eve/evals";

const TOOLKIT_INCIDENT_TOKEN = "toolkit-incident-dynamic-ok-7T2X";

/**
 * A map-produced dynamic skill authored in an extension must be namespaced by
 * the mount (`toolkit__incident`), not exposed under its bare map key
 * (`incident`). Loading it by the namespaced name proves the mount prefix
 * reaches map entries the way it already does for the extension's static and
 * dynamic tools.
 */
export default defineEval({
  description: "Map-produced dynamic skill from an extension is namespaced (toolkit__incident).",
  async test(t) {
    await t.send(
      "Please use the toolkit incident playbook skill and follow its instructions exactly.",
    );

    t.succeeded();
    t.loadedSkill("toolkit__incident", { output: new RegExp(TOOLKIT_INCIDENT_TOKEN, "u") });
    t.messageIncludes(TOOLKIT_INCIDENT_TOKEN);
  },
});
