import { fileURLToPath } from "node:url";
import { resolveShader } from "@vgpu/wgsl/runtime";

export async function load(url, context, nextLoad) {
  if (url.endsWith(".wgsl")) {
    const { wgsl } = await resolveShader({ entry: fileURLToPath(url), validate: false });
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(wgsl)};`,
    };
  }
  return nextLoad(url, context);
}
