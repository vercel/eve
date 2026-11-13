import { describe, expect, it } from "vitest";
import {
  browserBenchmarkFixtureContext,
  browserBenchmarkTasks,
} from "@evals/browser/tasks";

describe("browser benchmark tasks", () => {
  it("includes the focused Peek next-month calendar regression", () => {
    const task = browserBenchmarkTasks("all").find((candidate) =>
      candidate.prompt.includes("peek.com")
    );

    expect(task).toBeDefined();
    expect(task?.prompt).toContain("next calendar month");
    expect(task?.prompt).toContain("exactly one Adult");
    expect(task?.prompt).toContain("earliest enabled tour date");
  });

  it("keeps the smoke suite bounded to its existing two tasks", () => {
    expect(browserBenchmarkTasks("smoke")).toHaveLength(2);
  });

  it("includes four additional live browser workflows", () => {
    const descriptions = browserBenchmarkTasks("all").map(
      (task) => task.description
    );

    expect(browserBenchmarkTasks("all")).toHaveLength(10);
    expect(descriptions).toEqual(
      expect.arrayContaining([
        "Select a Yankees ticket before authentication",
        "Select an Elsewhere concert ticket before checkout",
        "Choose a facial moisturizer and verify the cart",
        "Choose a nonstop flight on Google Flights",
      ])
    );
  });

  it("tells the judge that personal and payment values are fixtures", () => {
    expect(browserBenchmarkFixtureContext).toContain("synthetic test fixtures");
    expect(browserBenchmarkFixtureContext).toContain("payment-card");
  });

  it("tests hotel navigation without requiring a global tax-total proof", () => {
    const hotelTask = browserBenchmarkTasks("all").find((task) =>
      task.prompt.includes("Booking.com")
    );

    expect(hotelTask).toBeDefined();
    expect(hotelTask?.prompt).toContain("Choose any room");
    expect(hotelTask?.prompt).not.toContain("lowest-total");
    expect(hotelTask?.successCriteria).toContain(
      "Do not require an exhaustive comparison"
    );
  });

  it("stops unauthenticated commerce tasks before login is required", () => {
    const tasks = browserBenchmarkTasks("all");
    const yankeesTask = tasks.find((task) => task.prompt.includes("Yankees"));
    const targetTask = tasks.find((task) =>
      task.prompt.includes("Target's website")
    );

    expect(yankeesTask?.prompt).toContain(
      "before entering any required sign-in"
    );
    expect(yankeesTask?.successCriteria).not.toContain(
      "final purchase boundary"
    );
    expect(targetTask?.prompt).toContain("stop before activating checkout");
    expect(targetTask?.successCriteria).not.toContain(
      "final checkout boundary"
    );
    expect(targetTask?.successCriteria).toContain(
      "Unrelated pre-existing cart items are outside the task"
    );
  });

  it("ends vertical-search tasks before unrelated checkout prerequisites", () => {
    const tasks = browserBenchmarkTasks("all");
    const flightTask = tasks.find((task) =>
      task.prompt.includes("Google Flights")
    );
    const elsewhereTask = tasks.find((task) =>
      task.prompt.includes("Elsewhere's official website")
    );

    expect(flightTask?.prompt).toContain("open its booking options");
    expect(flightTask?.prompt).toContain(
      "Stop before entering traveler information"
    );
    expect(flightTask?.successCriteria).not.toContain(
      "final purchase boundary"
    );
    expect(elsewhereTask?.prompt).toContain(
      "before continuing into any attendee-information"
    );
    expect(elsewhereTask?.successCriteria).not.toContain(
      "final purchase boundary"
    );
    expect(tasks.some((task) => task.prompt.includes("Expedia"))).toBe(false);
  });

  it("scopes Apple's address-correction rule to the Apple task", () => {
    const tasks = browserBenchmarkTasks("all");
    const appleTask = tasks.find((task) => task.prompt.includes("Apple's"));

    expect(appleTask).toHaveProperty("judgeContext");
    if (!appleTask || !("judgeContext" in appleTask)) {
      throw new Error("Apple benchmark task has no judge context.");
    }
    expect(appleTask.judgeContext).toContain("11222");
    expect(
      tasks.filter((task) => "judgeContext" in task && task.judgeContext)
    ).toHaveLength(1);
  });
});
