import Kernel from "@onkernel/sdk";
import { env } from "@/lib/environment/env";

let kernel: Kernel | undefined;

export function getKernel() {
  const apiKey = env.KERNEL_API_KEY;
  if (!apiKey) {
    throw new Error("Browser fallback is unavailable: KERNEL_API_KEY is not configured.");
  }
  return (kernel ??= new Kernel({ apiKey }));
}
