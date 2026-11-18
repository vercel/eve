export type WhimsyTask = "auth" | "teams" | "projects" | "project-name" | "project-detect";

const POOLS: Record<WhimsyTask, readonly string[]> = {
  auth: [
    "Knocking on Vercel's door...",
    "Checking your Vercel login...",
    "Making sure Vercel remembers you...",
    "Flashing your Vercel badge...",
    "Whispering the secret Vercel handshake...",
    "Confirming you are who Vercel thinks you are...",
  ],
  teams: [
    "Rounding up your Vercel teams...",
    "Summoning your Vercel teams...",
    "Asking Vercel which teams you run with...",
    "Counting heads across your Vercel teams...",
    "Taking attendance of your Vercel teams...",
    "Mapping out your Vercel teams...",
  ],
  projects: [
    "Leafing through the projects in {detail}...",
    "Fetching the projects in {detail}...",
    "Seeing what {detail} has been building...",
    "Dusting off the projects in {detail}...",
    "Taking inventory of {detail}'s projects...",
    "Peeking into {detail}'s project shelf...",
  ],
  "project-name": [
    "Checking that name against {detail}...",
    "Making sure {detail} has room for that name...",
    "Seeing if that project name is taken in {detail}...",
    "Calling dibs on that name in {detail}...",
    "Scanning {detail} for name collisions...",
  ],
  "project-detect": [
    "Checking the current Vercel project...",
    "Seeing which Vercel project lives here...",
    "Sniffing out the Vercel project in this directory...",
    "Reading this directory's Vercel papers...",
    "Looking up who deploys this directory...",
  ],
};

const lastPick = new Map<WhimsyTask, number>();

export function whimsyFor(
  task: WhimsyTask,
  detail?: string,
  pick: () => number = Math.random,
): string {
  const pool = POOLS[task];
  if (pool.length <= 1) {
    const only = pool[0] ?? "";
    return detail === undefined ? only : only.replaceAll("{detail}", detail);
  }
  const previous = lastPick.get(task);
  const size = previous === undefined ? pool.length : pool.length - 1;
  let index = Math.min(size - 1, Math.floor(pick() * size));
  if (previous !== undefined && index >= previous) index += 1;
  lastPick.set(task, index);
  const message = pool[index] ?? pool[0] ?? "";
  return detail === undefined ? message : message.replaceAll("{detail}", detail);
}

export const WHIMSY_POOLS = POOLS;
