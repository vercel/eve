import { create } from "eve/experimental/extensions/custom-skills";
import { defineDynamic } from "eve/tools";

import { customSkillsEnabled } from "../../../flags.js";

export default defineDynamic((ctx) =>
  customSkillsEnabled(ctx.session.auth.current) ? create : null,
);
