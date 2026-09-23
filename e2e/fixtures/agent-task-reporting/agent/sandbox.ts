import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";

export const environment = JustBashSandbox.environment({
  filesystem: ({ justBash }) => new justBash.InMemoryFs(),
});

export default defineSandbox(() => environment.open());
