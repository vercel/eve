import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";

// This eval exercises background-task delivery, not shell or filesystem behavior.
// Keep external sandbox provisioning out of the experiment.
export default defineSandbox({
  backend: justbash({
    filesystem: ({ justBash }) => new justBash.InMemoryFs(),
  }),
});
