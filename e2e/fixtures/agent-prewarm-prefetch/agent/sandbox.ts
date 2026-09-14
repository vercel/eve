import { defaultBackend, defineSandbox } from "eve/sandbox";

export default defineSandbox({
  backend: defaultBackend(),
  revalidationKey: () => "prefetch-v1",
  async bootstrap() {},
});
