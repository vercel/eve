import customSkills from "eve/experimental/extensions/custom-skills";
import { defaultScopes } from "eve/experimental/extensions/custom-skills/policies";
import { inMemory } from "eve/memory/file";
import { vercelBlob } from "eve/memory/file/vercel";

import { customSkillsEnabled } from "../../flags.js";

// A deployment's functions share no memory, so it keeps skills in Blob; one local process can use memory.
export default customSkills({
  storage: process.env.VERCEL ? vercelBlob() : inMemory(),
  namespace: "eve/e2e/agent-custom-skills",
  scopes: (ctx) => (customSkillsEnabled(ctx.session.auth.current) ? defaultScopes(ctx) : []),
});
