# Upstream parity review

Reviewed on November 16, 2026. Upstream repositories are the source of truth; this repository maintains compatible copies and local fixes to propose upstream. The revisions below pin this review, not the templates' npm dependencies. An integrated revision does not imply identical source trees.

## Reviewed revisions

| Internal template               | Upstream revision                          | Result                                                                              |
| ------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `bell-stack`                    | `ae8bd1f8adb95f8b27f3263b5527858fbe719b11` | Unchanged since import                                                              |
| `eve-agent-python-template`     | `c92518cbc607981de83d28b38e616a1a156b3c82` | Unchanged since import                                                              |
| `eve-chat-template`             | `d9989e032fc9ea02ef9dcfcaf4bc3b2ae69cb744` | Ported instant scrolling; retained current client integration                       |
| `eve-coding-agent-template`     | `32c219f57188cf4292b07fa26b2d61633be07f9e` | Independently authored counterpart; see below                                       |
| `eve-content-agent-template`    | `b71b33c53b2963c72a16aa0dd7fc5180ccdeb8f6` | Aligned model, Connect, and compatible documentation                                |
| `eve-contentful-agent-template` | `a05976e63a47653f7832db81a63ecc2bb12cbfc7` | Ported Slack routing, grouped publication previews, and delegated-publication guard |
| `eve-data-analyst-template`     | `90b51123dc28dd4d26c5c6f8cb29b020e558f0f4` | Ported native SQL approval cards and Slack edit handling                            |
| `eve-llm-council-template`      | `b591cd7abc96ba501d6a8ed455b577bbe41f13d7` | Upstream head already represented; retained current client integration              |
| `eve-mem0-template`             | `dbc29fee8342d019f21904c2a7dec0c9ddd9b4a0` | Unchanged since import                                                              |
| `eve-memory-agent-template`     | `fd414324954dff3f88bb7af547e4b1fc197f4dd2` | Ported Slack history and edit handling                                              |
| `eve-slack-agent-template`      | `d16e9ad3da23deb6b1b6ddbd8214d210e8cd3874` | Only upstream archive notices remain; retained sample-data corrections              |
| `eve-software-factory-template` | `1cd9fa53543d2ed007baf35fc9d44eb434e43c9c` | Adapted hardening, triage, CI diagnosis, and authenticated HTTP intake              |
| `eve-sre-agent-template`        | `6c5b79e3996dad4fb04f3ae3950df5c2d9dd8eb1` | Unchanged since import                                                              |
| `eve-tanstack-start-template`   | `c6e063ca63bf46f1369c66d3ab44b9f3f239c9ff` | Unchanged since import                                                              |
| `eve-vercel-drives-starter`     | `1224167d9db1e1d95ebb4a43216bbbb96030bd51` | Ported Slack edit handling and upstream model selection                             |
| `kody-eve-template`             | `2120cc2592f5be7f46dc49c55472fc520616db8d` | Ported trusted local-dev agent-info access and Connect update                       |
| `marketing-team-eve-template`   | `a23bd76fb2c8f690a734c09b2b9aef1924a1c999` | Aligned Connect; no new agent behavior upstream                                     |
| `openinstinct`                  | `d78cb0acf9724f5fa755e38e379c66138bdb8047` | Unchanged since import                                                              |
| `personal-agent-template`       | `c0a09b7a2cb62563d7f945f3b30cc65279cf5417` | Ported sign-in, attachment, search-error, question, and session-recovery behavior   |
| `sanity-copilot-eve-template`   | `e0f4d11858a25a641e6e5054e3cd64ee940fe4c6` | Ported shared Blob URL validation and upstream model/Connect selection              |

## Differences to reconcile upstream

Preserve local fixes during future imports and include them in the upstream parity PRs. In particular, keep authenticated resource access, private per-person memory, bounded inputs/downloads, confirmed publication delivery, and current eve APIs. Do not restore older client protocols or removed hooks to match a stale snapshot.

- Contentful checkpoints publication only after both preview delivery and successful native controls rendering. Nonleader interaction events cannot checkpoint a failed batch. Include this regression fix upstream.
- Slack templates retain verified sender authorization. Contentful and analyst retain their uncached-input usage policy; broader budget-policy changes need an explicit decision.
- Sanity retains fail-closed reserved-path validation, capped downloads, and bounded research inputs rather than upstream's more permissive normalization and uncapped research. Include the stronger URL/path regressions upstream.
- Kody retains disabled inbound email and automatic PR summaries, private preferences, and current GitHub permission checks. Its local-dev info grant does not change production authorization.
- Personal retains Sendblue, SQLite, and editable memory. Recovery preserves retired event streams separately and does not resend an ambiguously accepted request. Propose these recovery and sign-in race fixes upstream. Photon/PostgreSQL migration and optional per-user persistent Drive storage remain separate design work.
- Software factory retains isolated credentialed Git transfers, current GitHub/Linear membership checks, permanent intake claims, and private storage. See its [detailed parity decisions](./eve-software-factory-template/.github/UPSTREAM-PARITY.md) before porting credential tooling, signed commits, memory, callbacks, or automatic summaries.
- The coding-agent remote is an older dashboard/planning prototype, not the ancestor of this repository's functional Slack/GitHub agent. Reconcile that relationship upstream instead of overwriting the current agent with the prototype.
- Upstream coverage was reviewed selectively. Keep behavioral regression tests; avoid copying source inventories, broad test-only seams, or duplicate harnesses solely for textual parity.

Thanks @bensabic, @Anshuman71, and @allenzhou101 for the upstream implementations incorporated in this review.
