import { defineSelfModificationSandbox } from "eve/internal/self-modification/sandbox";
import selfModification from "../../extension.js";

export { defineSelfModificationSandbox } from "eve/internal/self-modification/sandbox";

export default defineSelfModificationSandbox({ config: selfModification.config });
