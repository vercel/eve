import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

export const environment = VercelSandbox.environment({ ports: [4319, 4320, 4321, 4322] });

export default defineSandbox(() => environment.open());
