import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  EVE_INTERNAL_AGENT_WORKSPACE_MEMBER_ENV,
  EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY_ENV,
  EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY_ENV,
} from "#internal/application/build-output-environment.js";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import {
  EVE_PUBLIC_ROUTE_PREFIX_ENV,
  normalizePublicRoutePrefix,
} from "#shared/public-route-prefix.js";
import { quoteVercelShellArgument, toVercelRelativePath } from "#internal/vercel/build-command.js";
import {
  assertValidVercelServiceName,
  isValidVercelServiceName,
  MAX_VERCEL_SERVICE_NAME_LENGTH,
} from "#internal/vercel/vercel-service-name.js";
import type {
  GeneratedVercelServiceConfig,
  VercelRouteConfig,
} from "#internal/vercel/vercel-services-config.js";

const EVE_VERCEL_SERVICES_DIRECTORY = ".eve/vercel-services";

export interface EveVercelAgentTarget {
  readonly appRoot: string;
  readonly buildCommand: string;
  readonly name?: string;
  readonly publicRoutePrefix: string;
  readonly workspaceMember?: boolean;
}

export interface EveVercelBuildTarget {
  readonly hostOutputDirectory: string;
  readonly projectRoot: string;
}

export interface EveVercelServiceContribution {
  readonly rootDirectory: string;
  readonly routeSrc: string;
  readonly service: GeneratedVercelServiceConfig;
  readonly serviceName: string;
}

function createServiceNameHash(value: string): string {
  return [...createHash("sha256").update(value).digest().subarray(0, 10)]
    .map((byte) => String.fromCharCode(97 + (byte % 26)))
    .join("");
}

/** Derive a stable Vercel service identifier without restricting the public agent name. */
export function createEveServiceName(name: string | undefined): string {
  if (name === undefined) return "eve";
  const directName = `eve-${name}`;
  if (isValidVercelServiceName(directName)) return directName;

  const suffix = createServiceNameHash(name);
  const readableName = name.replace(/[^a-z_-]+/g, "-").replace(/^[^a-z]+|[^a-z]+$/g, "") || "agent";
  const readableLength = MAX_VERCEL_SERVICE_NAME_LENGTH - "eve--".length - suffix.length;
  const readable = readableName.slice(0, readableLength).replace(/[^a-z]+$/g, "") || "agent";
  const serviceName = `eve-${readable}-${suffix}`;
  assertValidVercelServiceName(serviceName, "Generated eve service name");
  return serviceName;
}

export function createEveServiceRouteSrc(publicRoutePrefix: string): string {
  if (publicRoutePrefix.length === 0) return `^${EVE_ROUTE_PREFIX}/(.*)$`;
  const prefix = publicRoutePrefix.startsWith("/") ? publicRoutePrefix : `/${publicRoutePrefix}`;
  return `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${EVE_ROUTE_PREFIX}/(.*)$`;
}

export function createEveRequestPathRoute(routeSrc: string): VercelRouteConfig {
  return {
    src: routeSrc,
    transforms: [{ args: `${EVE_ROUTE_PREFIX}/$1`, op: "set", type: "request.path" }],
  };
}

export function createEvePublicRoute(serviceName: string, routeSrc: string): VercelRouteConfig {
  return { destination: { service: serviceName, type: "service" }, src: routeSrc };
}

function createIsolatedBuild(input: {
  readonly agent: EveVercelAgentTarget;
  readonly hostOutputDirectory: string;
  readonly projectRoot: string;
  readonly serviceName: string;
}): { readonly buildCommand: string; readonly root: string; readonly rootDirectory: string } {
  const rootDirectory = join(input.projectRoot, EVE_VERCEL_SERVICES_DIRECTORY, input.serviceName);
  const outputDirectory = join(rootDirectory, ".vercel", "output");
  const prefix = normalizePublicRoutePrefix(input.agent.publicRoutePrefix);
  const prefixExport =
    prefix === undefined
      ? ""
      : ` && export ${EVE_PUBLIC_ROUTE_PREFIX_ENV}=${quoteVercelShellArgument(prefix)}`;
  const workspaceMemberExport =
    input.agent.workspaceMember === true
      ? ` && export ${EVE_INTERNAL_AGENT_WORKSPACE_MEMBER_ENV}=1`
      : "";

  return {
    buildCommand: `cd ${quoteVercelShellArgument(toVercelRelativePath(rootDirectory, input.agent.appRoot))} && export ${EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY_ENV}=${quoteVercelShellArgument(toVercelRelativePath(input.agent.appRoot, outputDirectory))} && export ${EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY_ENV}=${quoteVercelShellArgument(toVercelRelativePath(input.agent.appRoot, input.hostOutputDirectory))}${prefixExport}${workspaceMemberExport} && ${input.agent.buildCommand}`,
    root: toVercelRelativePath(input.projectRoot, rootDirectory),
    rootDirectory,
  };
}

/** Compile one eve agent into its complete Vercel service and ingress contribution. */
export function compileEveVercelService(input: {
  readonly agent: EveVercelAgentTarget;
  readonly target: EveVercelBuildTarget;
}): EveVercelServiceContribution {
  const serviceName = createEveServiceName(input.agent.name);
  const routeSrc = createEveServiceRouteSrc(input.agent.publicRoutePrefix);
  const build = createIsolatedBuild({
    agent: input.agent,
    hostOutputDirectory: input.target.hostOutputDirectory,
    projectRoot: input.target.projectRoot,
    serviceName,
  });

  return {
    rootDirectory: build.rootDirectory,
    routeSrc,
    service: {
      buildCommand: build.buildCommand,
      framework: "eve",
      root: build.root,
      routes: [createEveRequestPathRoute(routeSrc)],
      ...(input.agent.publicRoutePrefix.length > 0
        ? { routePrefix: input.agent.publicRoutePrefix }
        : {}),
    },
    serviceName,
  };
}
