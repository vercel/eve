import { defineSandbox } from "eve/sandbox";
import { MicrosandboxSandbox } from "eve/sandbox/microsandbox";

export const environment = MicrosandboxSandbox.dockerfile({
  setup: { autoInstall: false },
});

export default defineSandbox(() => environment.open());
