import { defineSandbox } from "#public/definitions/sandbox.js";
import { DefaultSandbox } from "#sandbox/providers.js";

export const environment = DefaultSandbox.environment();
export default defineSandbox(() => environment.create());
