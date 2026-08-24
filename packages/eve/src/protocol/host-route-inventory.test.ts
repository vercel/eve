import { describe, expect, it } from "vitest";

import {
  getHostRouteRegistrations,
  getHostRouteReservations,
  HOST_ROUTE_INVENTORY,
  matchHostRouteRegistration,
} from "#protocol/host-route-inventory.js";

describe("host route inventory", () => {
  it("keeps route ownership, methods, and mounts closed and explicit", () => {
    expect(HOST_ROUTE_INVENTORY).toEqual([
      {
        id: "workflow",
        methods: ["ALL"],
        mounts: ["development-application", "production-application"],
        pathPattern: "/.well-known/workflow/v1/flow",
      },
      {
        id: "development-artifacts",
        methods: ["GET"],
        mounts: ["development-application", "development-control"],
        pathPattern: "/eve/v1/dev/runtime-artifacts",
      },
      {
        id: "development-artifacts-rebuild",
        methods: ["GET", "POST"],
        mounts: ["development-control"],
        pathPattern: "/eve/v1/dev/runtime-artifacts/rebuild",
      },
      {
        id: "development-artifacts-suspend",
        methods: ["POST"],
        mounts: ["development-control"],
        pathPattern: "/eve/v1/dev/runtime-artifacts/suspend",
      },
      {
        id: "development-artifacts-resume",
        methods: ["POST"],
        mounts: ["development-control"],
        pathPattern: "/eve/v1/dev/runtime-artifacts/resume",
      },
      {
        id: "development-workflow-world",
        methods: ["ALL"],
        mounts: ["development-control"],
        pathPattern: "/eve/v1/dev/internal/workflow-world",
      },
      {
        id: "development-workflow-stream",
        methods: ["ALL"],
        mounts: ["development-control"],
        pathPattern: "/eve/v1/dev/internal/workflow-world/stream",
      },
      {
        id: "development-schedule",
        methods: ["POST"],
        mounts: ["development-application"],
        pathPattern: "/eve/v1/dev/schedules/:scheduleId",
      },
      {
        id: "production-cron",
        methods: ["ALL"],
        mounts: ["production-application"],
        pathPattern: "/eve/v1/cron/:token",
        reservationOnly: true,
      },
    ]);
  });

  it("projects only registrations mounted at the requested boundary", () => {
    expect(getHostRouteRegistrations("production-application")).toEqual([
      {
        id: "workflow",
        method: "ALL",
        pathPattern: "/.well-known/workflow/v1/flow",
      },
    ]);
    expect(getHostRouteRegistrations("development-control")).toHaveLength(7);
    expect(getHostRouteRegistrations()).toHaveLength(9);
  });

  it("reserves the dynamic production cron match space without projecting a static registration", () => {
    expect(getHostRouteReservations("production-application")).toEqual([
      {
        id: "workflow",
        method: "ALL",
        pathPattern: "/.well-known/workflow/v1/flow",
        reservationOnly: false,
      },
      {
        id: "production-cron",
        method: "ALL",
        pathPattern: "/eve/v1/cron/:token",
        reservationOnly: true,
      },
    ]);
    expect(
      matchHostRouteRegistration({
        method: "POST",
        mount: "production-application",
        pathname: "/eve/v1/cron/build-secret",
      }),
    ).toBeUndefined();
  });

  it("matches methods and parameterized paths from the inventory", () => {
    expect(
      matchHostRouteRegistration({
        method: "POST",
        mount: "development-application",
        pathname: "/eve/v1/dev/schedules/nightly",
      }),
    ).toEqual({
      id: "development-schedule",
      method: "POST",
      pathPattern: "/eve/v1/dev/schedules/:scheduleId",
    });
    expect(
      matchHostRouteRegistration({
        method: "DELETE",
        mount: "development-control",
        pathname: "/eve/v1/dev/internal/workflow-world",
      }),
    ).toEqual({
      id: "development-workflow-world",
      method: "ALL",
      pathPattern: "/eve/v1/dev/internal/workflow-world",
    });
    expect(
      matchHostRouteRegistration({
        method: "POST",
        mount: "development-control",
        pathname: "/eve/v1/dev/runtime-artifacts",
      }),
    ).toBeUndefined();
    expect(
      matchHostRouteRegistration({
        method: "GET",
        mount: "development-application",
        pathname: "/eve/v1/dev/runtime-artifacts/",
      }),
    ).toEqual({
      id: "development-artifacts",
      method: "GET",
      pathPattern: "/eve/v1/dev/runtime-artifacts",
    });
  });
});
