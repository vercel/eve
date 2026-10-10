import { createFileRoute } from "@tanstack/react-router";

import { EveAgentConsole } from "../components/EveAgentConsole";

export const Route = createFileRoute("/")({
  component: EveAgentConsole,
});
