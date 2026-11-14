import customSkills from "eve/experimental/extensions/custom-skills";
import { inMemory } from "eve/memory/file";
import { vercelBlob } from "eve/memory/file/vercel";

// Skills share memory's Blob store: the one `eve integration setup file-memory`
// connects as EVE_MEMORY_BLOB_*, or the Deploy button's BLOB_* store. Under
// `eve dev` they live in process memory, like memory does.
const storeId = process.env.EVE_MEMORY_BLOB_STORE_ID?.trim();
const token = process.env.EVE_MEMORY_BLOB_READ_WRITE_TOKEN?.trim();

// Personal skills follow each person into every conversation. Channel skills
// apply to everyone in a Slack channel or group DM, and someone other than
// their author approves them before they go live.
export default customSkills({
  storage: process.env.VERCEL
    ? vercelBlob(storeId ? { storeId } : token ? { token } : {})
    : inMemory(),
  namespace: "company-brain/skills",
});
