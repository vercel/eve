import code from "eve/extensions/code";

import { deployedGitHubConfig } from "../../../github.js";
import selfModification from "../../../extension.js";

export default code({ github: deployedGitHubConfig(selfModification.config) });
