---
title: "Responsible Use"
description: "Deployer responsibility and safeguards to review before using eve with sensitive, regulated, or production data."
---

As the deployer, it is your responsibility to ensure your agent complies with applicable laws.

You are responsible for configuring approval policies, tool restrictions, connection scopes, route/session authorization, sandbox controls, telemetry exports, and other safeguards appropriate for your use case.

Before using eve with non-public, sensitive, regulated, or production data, review which default tools, custom tools, MCP tools, shell/file/web tools, connected services, subagents, schedules, and external actions are available to the agent.

Require human approval or other safeguards for sensitive, irreversible, regulated, financial, healthcare, employment, housing, legal, safety-impacting, user-impacting, or external side-effecting actions.

Unless you configure stricter controls, eve agents may operate with permissive settings, including tool execution without human approval where approval is omitted and sandbox network egress that is not deny-all. Do not rely on model behavior alone to prevent sensitive or irreversible actions.
