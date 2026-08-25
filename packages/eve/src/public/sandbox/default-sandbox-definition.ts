import { defineSandbox } from "#public/definitions/sandbox.js";

/**
 * Framework default sandbox definition, applied when an agent does not author
 * a `sandbox.ts` of its own. Omitting `backend` selects the environment
 * default backend at runtime.
 */
export default defineSandbox({});
