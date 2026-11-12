---
"eve": patch
---

Publish `ghcr.io/vercel/eve-git`, eve's default sandbox image plus the GitHub CLI (`gh`), and the same image to Vercel Container Registry as `vcr.vercel.com/vercel/eve/git`.

Start a sandbox `Dockerfile` from it with `FROM ghcr.io/vercel/eve-git:latest` so `installCodeTooling` from `eve/extensions/code/sandbox` finds `gh` and skips its `apt-get` install, which takes about 7 seconds of a first build. The default image is unchanged.
