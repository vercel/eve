import { defineDynamic } from "eve/connections";

// Runtime account names are unknown at build time, even when no account is enabled yet.
export default defineDynamic({ events: { "session.started": () => null } });
