import customSkills from "eve/experimental/extensions/custom-skills";
import { inMemory } from "eve/memory/file";
import { vercelBlob } from "eve/memory/file/vercel";

// A deployment's functions share no memory, so it keeps skills in Blob; one local process can use memory.
export default customSkills({
  storage: process.env.VERCEL ? vercelBlob() : inMemory(),
  namespace: "eve/e2e/agent-custom-skills",
});
