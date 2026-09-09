---
issue: TBD
status: implemented
last_updated: "2026-09-09"
---

# Session activity API

> **AI status:** Written entirely by AI; human review pending.

## Goal

Expose the existing activity collector's channel-neutral snapshots to authenticated local and remote clients without enabling collection for any additional agent or channel.

## Public contract

`GET /eve/v1/session/:sessionId/activity/stream` serves an NDJSON stream of complete `ActivitySnapshotV1` revisions. It accepts the session stream's `startIndex` and `includeTailIndex` query parameters and uses the same route authentication. Unknown sessions, child sessions, sessions whose channel did not start a collector, and missing collectors return `404`.

The TypeScript client exposes the same data through `session.activity.snapshot()` and `session.activity.stream()`. Activity uses an independent stream cursor so reading progress cannot advance or rewind session history.

## Persistence and ownership

When an existing channel activity renderer causes a root collector to start, eve records the collector run ID in a private `$eve.activity_collector` attribute on the new root session run. The collector writes each revision-changing snapshot immediately to its named `eve.activity.snapshots` durable stream. Its existing renderer debounce remains independent, so API publication does not delay snapshot readers and snapshot readers do not increase provider updates.

The reporting capability route remains write-only. Clients resolve activity through the authenticated root-session route and never receive its collector token.

## Scope

This change does not start collectors for sessions that did not already opt into channel activity rendering, expose raw activity batches, reconstruct historical activity from session events, or provide activity for child session IDs.
