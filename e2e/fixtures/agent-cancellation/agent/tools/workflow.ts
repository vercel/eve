import { workflow } from "eve/tools/workflow";

export default workflow({
  agents: ["sleeper", "steering-worker"],
});
