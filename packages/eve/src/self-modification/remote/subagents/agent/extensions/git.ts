import git from "eve/extensions/git";

import { deployedGitHubConfig } from "../../../github.js";
import selfModification from "../../../extension.js";

export default git({ github: deployedGitHubConfig(selfModification.config) });
