import { defineDynamic, defineInstructions } from "eve/instructions";

import extension from "../extension.ts";
import { formatConfiguredModelGuidance } from "../lib/model.ts";

export default defineDynamic(() =>
  defineInstructions({ content: formatConfiguredModelGuidance(extension.config) }),
);
