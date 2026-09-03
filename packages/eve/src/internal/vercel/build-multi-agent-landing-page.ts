import type { AgentWorkspace } from "#internal/project-context.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Build the public root page for a hostless multi-agent deployment. */
export function buildMultiAgentLandingPage(workspace: AgentWorkspace): string {
  const agents = workspace.members
    .map(
      (member) =>
        `<li><a href="/${encodeURIComponent(member.name)}/">${escapeHtml(member.name)}</a></li>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>eve</title>
<style>body{margin:0;background:#fff;color:#0a0a0a;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;min-height:100vh;place-items:center;padding:2rem}main{max-width:28rem;width:100%}h1{font-size:1rem;margin:0 0 .5rem}p{color:#6b6b6b;margin:0 0 1.5rem}ul{list-style:none;margin:0;padding:0;border:1px solid rgba(0,0,0,.12);border-radius:.5rem}li+li{border-top:1px solid rgba(0,0,0,.12)}a{color:inherit;display:block;padding:.875rem 1rem;text-decoration:none}a:hover{text-decoration:underline}@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#f5f5f5}p{color:#a3a3a3}ul,li+li{border-color:rgba(255,255,255,.16)}}</style>
</head>
<body><main><h1>eve agents</h1><p>${workspace.members.length} agents are ready.</p><ul>${agents}</ul></main></body>
</html>
`;
}
