import { defineSandbox } from "#public/sandbox/index.js";
import { justbash } from "#public/sandbox/just-bash.js";

import { createSelfModificationFilesystem } from "./filesystem.js";

export default defineSandbox({
  backend: justbash({ filesystem: createSelfModificationFilesystem }),
});
