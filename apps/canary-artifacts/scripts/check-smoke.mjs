const origin = process.env.DEPLOYMENT_URL;
if (!origin) throw new Error("DEPLOYMENT_URL is required.");

const url = `${origin.replace(/\/$/, "")}/canary/eve.tgz`;
const response = await fetch(url, { redirect: "manual" });
const location = response.headers.get("location") ?? "";
if (
  location.includes("vercel.com/login") ||
  location.includes("vercel.com/sso-api") ||
  location.includes("/_vercel/login")
) {
  throw new Error("Canary deployment is protected; disable Deployment Protection.");
}
if (!response.ok) throw new Error(`/canary/eve.tgz returned ${response.status}.`);

const signature = new Uint8Array(await response.arrayBuffer()).subarray(0, 2);
if (signature[0] !== 0x1f || signature[1] !== 0x8b) {
  throw new Error("Canary artifact is not a gzip tarball.");
}
