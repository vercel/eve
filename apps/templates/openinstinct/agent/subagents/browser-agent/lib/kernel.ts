import Kernel from "@onkernel/sdk";
import { env } from "@shared/environment";

export const kernel = new Kernel({ apiKey: env.KERNEL_API_KEY });
