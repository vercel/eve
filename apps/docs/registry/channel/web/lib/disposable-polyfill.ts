/**
 * Inline polyfill for Explicit Resource Management symbols.
 *
 * eve's browser client (`eve/react`) compiles `using` declarations and defines
 * `[Symbol.dispose]()` methods at module load. Browsers without the proposal
 * (Safari, older Chrome and Firefox) fail with "Symbol.dispose is not defined."
 * when a session resumes. This script runs in <head> before any client chunk.
 */
export const disposablePolyfillScript = [
  "(function(){",
  'if(typeof Symbol!=="function")return;',
  'if(!Symbol.dispose){Object.defineProperty(Symbol,"dispose",{value:Symbol.for("Symbol.dispose"),configurable:false,enumerable:false,writable:false});}',
  'if(!Symbol.asyncDispose){Object.defineProperty(Symbol,"asyncDispose",{value:Symbol.for("Symbol.asyncDispose"),configurable:false,enumerable:false,writable:false});}',
  "})();",
].join("");
