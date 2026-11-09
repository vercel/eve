import { DefaultSandbox, defineSandbox } from "eve/sandbox";

export const environment = DefaultSandbox.environment();

export default defineSandbox(() => environment.open({ networkPolicy: "deny-all" }));
