# Release notes format specs

Quick-lookup conventions for release notes and changelogs. These are mostly *conventions*, not
hard numeric limits — the sourced standard is below; the rules-of-thumb are marked as such. Only
assert the conventions you can cite.

## Categories (Keep a Changelog)

The standard category set, with the exact one-line definitions. Use only the categories that
apply to a release, and keep the same names every time.

| Category | Use for |
| --- | --- |
| **Added** | New features. |
| **Changed** | Changes in existing functionality. |
| **Deprecated** | Soon-to-be removed features. |
| **Removed** | Now-removed features. |
| **Fixed** | Bug fixes. |
| **Security** | Vulnerabilities. |

Resist inventing categories ("Tweaks", "Misc", "Improvements" as a catch-all) — the six above are
specific enough to be useful and broad enough to cover everything. Always pass a feature through
**Deprecated** before **Removed**.

## Semantic Versioning mapping

Given `MAJOR.MINOR.PATCH`, increment the:

| Part | When | Backward compatible? |
| --- | --- | --- |
| **MAJOR** | Incompatible API changes. | No |
| **MINOR** | New functionality added in a backward-compatible way (or a public API marked deprecated). | Yes |
| **PATCH** | Backward-compatible bug fixes. | Yes |

- A breaking change is "any backward incompatible change to the public API" — that forces a MAJOR
  bump, and resets MINOR and PATCH to 0.
- `0.y.z` is for initial development: anything may change at any time, and the public API should
  not be considered stable. `1.0.0` defines the public API.
- The version number tells the reader the risk of upgrading before they read a single entry, so a
  changelog reads best paired with SemVer.

## Entry anatomy

A repeatable skeleton for one entry. Keep it to one or two sentences; link out for the rest.

```
[Category] <What changed, from the reader's side — "You can now…" / "Fixed an issue where…">.
<Why it matters, if not obvious.> <What to do / where to go, or a link to learn more.>
```

- Front-load the benefit in the first sentence so it survives a skim.
- Describe a fix from the symptom the reader saw, not the internal code path.
- Put breaking changes first, with the migration steps and a timeline when there is one.

## Ordering & dating

| Convention | Value |
| --- | --- |
| Order | Newest version first (reverse chronological). |
| Date format | ISO 8601, `YYYY-MM-DD` (orders largest-to-smallest: year, month, day — no regional ambiguity). |
| Version + section | Linkable, so a reader can jump to a specific release. |
| Unreleased | An optional `Unreleased` section at the top tracks upcoming changes. |
| Yanked | Mark a pulled release visibly, e.g. `## [0.0.5] - 2014-12-13 [YANKED]`. |

Every shipped version gets an entry, even a minor one — gaps erode trust.

## Rules of thumb (not sourced limits)

These are editorial defaults, not published specs — adjust to the surface:

- One or two sentences per entry; a 2–3 bullet highlights overview at the top of a larger release.
- A short heading set per release — only the categories that have entries.
- A screenshot or short GIF when a visual explains a redesign or new flow faster than prose.

## Sources

- Keep a Changelog 1.1.0: https://keepachangelog.com/en/1.1.0/
- Semantic Versioning 2.0.0: https://semver.org/
- AnnounceKit — Release Notes Best Practices (2026): https://announcekit.app/guides/release-notes-best-practices
- LaunchNotes — How to Write Great Product Release Notes: https://www.launchnotes.com/blog/how-to-write-great-product-release-notes-the-ultimate-guide
