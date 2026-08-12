const origin = process.env.DEPLOYMENT_URL;
if (!origin) throw new Error("DEPLOYMENT_URL is required.");

const latest = await fetch(`${origin.replace(/\/$/, "")}/canary/latest`, { redirect: "manual" });
const location = latest.headers.get("location") ?? "";
if (
  location.includes("vercel.com/login") ||
  location.includes("vercel.com/sso-api") ||
  location.includes("/_vercel/login")
) {
  throw new Error("Canary deployment is protected; disable Deployment Protection.");
}
if (latest.status !== 302) throw new Error(`/canary/latest returned ${latest.status}.`);

const artifact = await fetch(location);
if (!artifact.ok) throw new Error(`Canary artifact returned ${artifact.status}.`);
const signature = new Uint8Array(await artifact.arrayBuffer()).subarray(0, 2);
if (signature[0] !== 0x1f || signature[1] !== 0x8b) {
  throw new Error("Canary artifact is not a gzip tarball.");
}
