import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";

export const environment = JustBashSandbox.environment({ autoInstall: false });
export default defineSandbox(() => environment.open());
