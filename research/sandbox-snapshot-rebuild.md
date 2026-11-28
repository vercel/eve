---
issue: https://github.com/vercel/eve/pull/6712
status: implemented
last_updated: "2026-11-22"
---

# Sandbox snapshot rebuild

> **AI status:** Written entirely by AI; human review pending.

## Summary

`eve build` captures one Vercel Sandbox snapshot per deployment, and every new session opens from it. When `prepare` clones a large repository, that snapshot holds the repository as it was at deploy. A session that starts hours later is behind by every commit pushed since.

This work lets an app refresh that snapshot after deploy. A schedule reads the branch head, rebuilds the snapshot in a throwaway sandbox when the head moved, and moves a pointer that new sessions read. New sessions start on a snapshot at most one schedule interval plus one rebuild behind the branch, with no redeploy and no work at session start.

| Measured on `vercel/next.js` (8 vCPU, node24) | Time       |
| --------------------------------------------- | ---------- |
| Cold clone                                    | 6.2 s      |
| Install                                       | 12.7 s     |
| `snapshot()` of a 1.0 GB sandbox              | 7.2 s      |
| New session from a snapshot                   | 1.1–1.7 s  |
| Rebuild after a source-only push              | 18–22 s    |
| Rebuild after a lockfile push                 | about 21 s |

`vercel/next.js` is smaller than the private monorepo this was built for, so read the numbers as a floor.

## Options compared

Three ways to get a repository's newest commit into new sessions without a redeploy.

|                                           | Rebuild the snapshot                      | Repo Drive                                    | Fetch on open                                                       |
| ----------------------------------------- | ----------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| Copy in the session                       | Writable, on local disk                   | Read-only mount                               | Writable, on local disk                                             |
| Work when a session starts                | None                                      | One Drive mount, plus eve's base setup script | `git fetch` and checkout, plus an install when the lockfile changed |
| When a push reaches new sessions          | One interval plus one rebuild             | One interval plus one refresh                 | At once                                                             |
| Where the code changes                    | eve core and eve-git                      | eve-git only                                  | The app only                                                        |
| Callable from a channel, schedule or tool | Yes, one exported function                | Yes, one exported function                    | No, it runs only inside the sandbox definition                      |
| Storage left behind                       | One snapshot per rebuild until it expires | One Drive, one folder per commit              | None                                                                |

**Rebuild the snapshot** was chosen. It is the only option that gives a writable repository with no extra work at session start, and eve already keeps the pointer it needs.

**A repo Drive** fails for an agent that edits the repository. The mount is read-only, so the agent would copy a large repository into `/workspace` before changing anything, and that copy costs time at every session start. A mount also turns off the fast start that a session created from eve's default snapshot gets, so each session reruns the base setup script. A Drive's region is fixed, and a sandbox mounts at most 4 Drives.

**Fetch on open** makes every new session pay for the fetch, and for a full install each time the lockfile changed since the deployed snapshot. It cannot be called from a channel or a tool. It stays possible on top of a rebuilt snapshot, where it would fetch only the few commits since the last rebuild. That layering is deferred.

All three share one limit. A session that resumes reuses its own persistent sandbox, so freshness only reaches new sessions.

## How a rebuild works

eve already keeps a stopped sandbox named `eve-sbx-tpl-vercel-<hash>` for each template, the pointer. Its `sourceSnapshotId` is the newest snapshot. Snapshots expire and Vercel Sandbox has no "latest" alias, so the pointer is how eve finds the newest one. On `main` only `eve build` reads it.

| Step            | What runs                                                                                                                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New session     | `openSession` reads the pointer for the build's template key and opens from its snapshot. If the pointer is missing, its snapshot returned 410, or the read fails, it opens from `artifact.snapshotId`. A failed read logs `could not read the sandbox template pointer, using the deployed snapshot`. |
| Rebuild         | `rebuildSandboxTemplate({ revision, prepare })` opens a temporary sandbox from the snapshot a new session would open from, runs `prepare`, snapshots it, and publishes the pointer.                                                                                                                    |
| Skipped rebuild | It returns `{ rebuilt: false }` without running `prepare` when the pointer already carries `revision`, or another rebuild of the same template runs in the process.                                                                                                                                    |
| Failed rebuild  | A `prepare` that throws, or a publish conflict, deletes the new snapshot and leaves the pointer as it was.                                                                                                                                                                                             |
| Resume          | Untouched. A resumed session keeps its own sandbox.                                                                                                                                                                                                                                                    |

`sandbox.snapshot()` stops the sandbox it runs in, so every rebuild uses a throwaway sandbox.

`sandbox.run()` returns `{ exitCode }` and does not throw. A `prepare` that does not check it publishes the result of a failed command, so the docs and the JSDoc examples throw on a non-zero exit code.

### Publishing the pointer

The Vercel Sandbox SDK has no way to change a sandbox's source snapshot, so a swap deletes the pointer and creates it again under the same name. Creating first fails because the name is taken.

I probed the swap against a real sandbox.

| Probe                                                             | Result                                   |
| ----------------------------------------------------------------- | ---------------------------------------- |
| Delete then create, 20 runs, half with a `Sandbox.get` in between | 20 of 20 succeeded, no name-in-use error |
| First `Sandbox.get` after `delete()`                              | 404 in 10 of 10 runs                     |
| `delete()` median                                                 | 137 ms                                   |
| No-pointer window during a swap                                   | about 110 to 160 ms                      |

A session that opens inside that window finds no pointer and opens from `artifact.snapshotId`, so the window costs a slightly older snapshot and never fails a session. A 503 injected on the pointer read gave the same result: two new sessions opened on the deployed snapshot in about 3.5 s.

`publishTemplatePointer` keeps the previous pointer, deletes it, creates the new one, and puts the old one back if the create fails. It keeps the author's `tags` beside `eve-template-revision`.

A session fails with `SandboxTemplateNotProvisionedError` only when the pointer's snapshot and the deployed snapshot have both expired. A rebuild that finds no snapshot left throws and asks for a redeploy.

### The cost of the pointer read

Every prepared Vercel environment records its `templateKey` in the build artifact, and every new session reads the pointer once. The read alone takes 51 to 88 ms. Opening a session had a median of 840 ms with the read against 780 ms on `main` (10 sessions each), out of 800 to 1,700 ms for a cold sandbox. Resumes, later turns and environments without a snapshot make no read.

## Whether to flag a sandbox as rebuildable

The first version added `rebuildable: true` to `VercelSandboxCreateOptions`. Without it the build omitted `templateKey` from the artifact, and `openSession` skipped the pointer read. The flag only saved those 51 to 88 ms on apps that never rebuild. It did not change what `eve build` provisioned, because every prepared environment already maintained the pointer.

It was removed for three reasons.

- **The setting was in the wrong place.** An app that wants scheduled rebuilds sets the flag in `agent/sandbox.ts` and wires the schedule in another file. Forgetting the flag builds cleanly and throws only after deploy.
- **It was permanent API for a gap in the SDK.** Whether a sandbox is rebuildable is not a property of the sandbox. If Vercel Sandbox adds a mutable snapshot alias, the read goes away and the flag would be dead configuration.
- **It lost expiry recovery.** With the key always recorded, an older deployment whose `artifact.snapshotId` expired can open from a snapshot that a newer deployment published under the same key.

| Option                                    | Cost for an app that never rebuilds                | Public API       | Outcome                                                                                              |
| ----------------------------------------- | -------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------- |
| Always read the pointer (chosen)          | 51–88 ms once per new session                      | None             | Fewest states. A failed read already falls back.                                                     |
| Always read, plus a 60 s in-process cache | 51–88 ms on a cold function, about 0 on a warm one | None             | Rejected. Adds cache state, and a warm instance can serve a snapshot up to 60 s old after a rebuild. |
| Keep the flag                             | 0 ms                                               | A public boolean | Rejected for the reasons above.                                                                      |

## Template keying

The pointer name is `eve-sbx-tpl-vercel-` and the first 32 hex characters of a SHA-256 over six inputs.

| Input            | What it holds                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `createOptions`  | The Vercel create options with eve's env and `timeout` defaults, minus `fetch`, `projectId`, `signal`, `teamId` and `token` |
| `resolvedImage`  | The base image string, or nothing when `source` is set                                                                      |
| `version`        | The template format number, currently `4`                                                                                   |
| `vercelEnv`      | `VERCEL_TARGET_ENV` at build time, else `VERCEL_ENV`                                                                        |
| `resources`      | A hash of the workspace and skill files                                                                                     |
| `sourceRevision` | A hash of the bytes of `agent/sandbox.ts`                                                                                   |

The key leaves out files that `agent/sandbox.ts` imports and the contents of an image behind a mutable tag. Editing `agent/sandbox.ts` forces a new template.

### Why the environment is in the key

Without `vercelEnv`, a preview build and a production build of the same agent files share a pointer. A scheduled rebuild on preview would then publish a snapshot that production sessions open, and a preview build could seed the production snapshot. A Vercel Security Review finding raised exactly this. Every app is keyed by environment, not only the ones that rebuild, because a preview build on any app can otherwise publish over production's pointer.

A real-sandbox run showed three environments resolve to three pointers. A preview rebuild moved only the preview pointer, and a new production session still opened on the production snapshot.

The cost is that each app builds its template once more on the first deploy after upgrading, and a production deploy runs its own `prepare` instead of reusing the preview template.

## API shape

- **`rebuildSandboxTemplate`** is exported from `eve/sandbox/vercel`. It is the only new surface in core. A schedule, a channel or a tool calls it with a `revision` and a `prepare`.
- **`refreshRepoSnapshot` and `repoSnapshotSchedule`** are exported from `eve/extensions/git`. The refresh reads the branch head from the GitHub API with a read-only token from Connect and stops if the head has not moved. Otherwise it calls the rebuild with a `prepare` that fetches the head into `origin/<branch>`, resets to it, and runs the app's `install` only when a lockfile changed.
- **The schedule is a file in the app.** The first design had an always-on schedule inside the extension, switched on by config. A schedule file shipped in an extension cannot be turned off by config, so the extension exports `repoSnapshotSchedule` and the app adds one file under `agent/schedules/` that default-exports it.
- **The revision label** hashes the repository, branch, directory and head, so changing any of them rebuilds.
- **The GitHub token never enters the sandbox.** The fetch runs behind a network policy that adds the token as a header on requests to `github.com`. Before `install` runs, the policy goes back to `allow-all` and the header is gone. A real sandbox probe could not reach a private repository during `install`.
- **The default cron is every 15 minutes.** A rebuild takes 18 to 22 s on `vercel/next.js`, so the interval stays well above one rebuild.

## What was tested on a real sandbox

Both runs used `eve build` and `eve start` on a Mac against a real Vercel Sandbox in the playground team, with a scripted model and a public scratch repository.

| Check                                        | Result                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| A new session after a push                   | Opens on the pushed commit                                               |
| A second rebuild with the same revision      | `rebuilt: false` in 0.16 s                                               |
| A throwing `prepare`                         | Pointer and snapshot list unchanged                                      |
| A new `eve build` with the same sandbox file | Keeps the rebuilt snapshot                                               |
| The pointer's snapshot deleted               | New sessions open on the build's snapshot, and the next rebuild recovers |
| Unchanged head                               | No rebuild, 0.3 to 0.6 s                                                 |
| Source-only push                             | Rebuilds in 4.5 to 6.8 s, `install` not called                           |
| Lockfile push                                | Rebuilds in 5.2 to 20 s, `install` called once                           |
| `install` throws                             | New sessions stay on the previous commit                                 |

What the runs did not cover:

- Both ran locally with `eve start`, not as a Vercel deploy.
- The schedule token came from `gh`. The real Connect call returned `Connector not found` because no GitHub connector existed, so the Connect token path has not run end to end.
- One lockfile rebuild took 20 s against 5 to 6 s for the others, and the cause is unknown.
- A custom Vercel environment, keyed by `VERCEL_TARGET_ENV`, has not run on a real sandbox.

## Storage cost and expiry

A rebuild never deletes the snapshot it replaces, because another live deployment may name it as its `artifact.snapshotId`. Replaced snapshots expire 30 days after last use.

Snapshot storage costs $0.08 per GB-month ([pricing](https://vercel.com/docs/sandbox/pricing)). A branch that moves every 15 minutes, all day, makes up to 96 snapshots a day, so about 2,880 live at once. At 1 GB each that is about $230 a month, as an upper bound. A branch with fewer pushes makes proportionally fewer.

An app that rebuilds and then gets no push for 30 days has a pointer whose snapshot expires. New sessions then open from the deployed snapshot, which also expires 30 days after the deploy unless a rebuild started from it. After that sessions fail until a redeploy captures a new snapshot.

## Deferred

- **Shorter expiry on rebuilt snapshots**, or deleting snapshots no live deployment names. The app can set `snapshotExpiration` in its sandbox options today.
- **Fetch on open** over a rebuilt snapshot, to remove the interval's lag.
- **A keep-alive** for an idle app, only if storage or expiry shows up in the bill.
- **A mutable snapshot alias** in Vercel Sandbox, which would replace the delete-then-create swap and the pointer read.
