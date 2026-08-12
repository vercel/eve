const origin = process.env.DEPLOYMENT_URL;
if (!origin) throw new Error("DEPLOYMENT_URL is required.");

const artifact = await fetch(`${origin.replace(/\/$/, "")}/main/eve.tgz`, { redirect: "manual" });
const location = artifact.headers.get("location") ?? "";
if (
  location.includes("vercel.com/login") ||
  location.includes("vercel.com/sso-api") ||
  location.includes("/_vercel/login")
) {
  throw new Error("Package deployment is protected; disable Deployment Protection.");
}
if (artifact.status !== 302) throw new Error(`/main/eve.tgz returned ${artifact.status}.`);

const tarball = await fetch(location);
if (!tarball.ok) throw new Error(`Package artifact returned ${tarball.status}.`);
const signature = new Uint8Array(await tarball.arrayBuffer()).subarray(0, 2);
if (signature[0] !== 0x1f || signature[1] !== 0x8b) {
  throw new Error("Package artifact is not a gzip tarball.");
}
