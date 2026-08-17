import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";

import { createSelfmodFilesystem } from "./filesystem.js";

export default defineSandbox({
  backend: justbash({ filesystem: createSelfmodFilesystem }),
});
