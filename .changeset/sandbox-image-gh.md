---
"eve": patch
---

Publish `ghcr.io/vercel/eve-git`, eve's default sandbox image plus the GitHub CLI (`gh`), and the same image to Vercel Container Registry as `vcr.vercel.com/vercel/eve/git`.

Each eve release pins one tag of it, exported as `DEFAULT_EVE_GIT_SANDBOX_IMAGE` from `eve/sandbox/docker` and `VERCEL_EVE_GIT_SANDBOX_IMAGE` from `eve/sandbox/vercel`, and both from `eve/extensions/git/sandbox`, and `latest` moves to the tag of the released eve package.

Pass the constant as `image` so `installCodeTooling` from `eve/extensions/code/sandbox` finds `gh` and skips its `apt-get` install, which takes about 7 seconds of a first build. A Vercel Sandbox session from a prepared snapshot of the eve-git image runs no base setup command, like the default image. The default image is unchanged.
