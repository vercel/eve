import { defaultBackend, defineSandbox } from "eve/sandbox";

export default defineSandbox({
  backend: defaultBackend(),
  revalidationKey: () => "control-v1",
  async bootstrap() {},
});
