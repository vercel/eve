---
issue: TBD
status: in-progress
last_updated: "2026-09-14"
---

# From init to chat

Interactive `eve init` scaffolds and opens the TUI. Connection readiness replaces the model, channels, integrations, and review interview. `/login` connects; `/model` selects models and settings; `/add` searches and installs one addition immediately.

The public direct-provider surfaces are `openai(model?)` from `eve/models/openai` and `anthropic(model?)` from `eve/models/anthropic`, alongside `chatgpt(model?)`. Defaults are `gpt-5.6-luna-fast` and `claude-sonnet-5`. Source edits recognize eve-owned helpers and reject unsafe custom expressions.

A project's choice wins over discovery. New connections prefer explicit environment credentials, the machine default, then Vercel CLI's current team. Projectless Gateway requests carry the account token and validated `x-vercel-ai-gateway-team` header. CLI credential rotation remains CLI-owned. eve-owned refresh credentials and keys use just-secrets; rotating access tokens remain in memory behind a credential broker and cross-process refresh lock. Authored files, generated artifacts, and workflow state contain no discovered secrets. Local discovery never supplies deployment credentials.

Menus retain eve's renderer and scrollback with borderless rows, a `›` marker, bold selection, dim secondary text, filtering, and Enter/Esc navigation. Authorization semantics and required setup remain intact. Connection-ready and first-response telemetry contains timing and state only.

Release acceptance requires projectless Gateway account-token support for the intended audience; this backend capability is feature-gated. The OAuth client ID is isolated and temporarily shared with fx pending registration of eve's own application. Deterministic tests cover routing and failure behavior. Local acceptance on 2026-09-14 also validated the existing CLI account/team and streamed a `gpt-5.6-luna-fast` response without a linked project. CI fixture evals remain the end-to-end gate.

Vercel CLI installation and account login belong to interactive deployment, including already-linked projects. `/vc:install` and `/vc:login` are removed. Remote chat reuses existing credentials without starting a browser login; noninteractive deployment remains nonblocking.
