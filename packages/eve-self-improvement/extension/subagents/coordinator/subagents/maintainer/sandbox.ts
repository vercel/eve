import { defineSandbox } from "eve/sandbox";
import { environment as hostedEnvironment } from "../../../../lib/hosted.js";

export const environment = hostedEnvironment;

export default defineSandbox(() => environment.open());
