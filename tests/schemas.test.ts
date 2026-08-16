import { describe, expect, it } from "vitest";
import { createActionSchema, createGoalSchema, logGoalProgressSchema, profileSchema } from "../src/schemas.js";

describe("avatar schema", () => {
  it("accepts independently mixed character parts", () => {
    expect(profileSchema.safeParse({ avatarKey: "amara-blue-teal" }).success).toBe(true);
    expect(profileSchema.safeParse({ avatarKey: "unknown-blue-teal" }).success).toBe(false);
  });
});

describe("goal metrics and item reminders", () => {
  const goal = {
    title: "Run 100 km",
    category: "HEALTH",
    startDate: "2026-08-16T00:00:00.000Z",
  };

  it("requires metric unit and target together", () => {
    expect(createGoalSchema.safeParse({ ...goal, metricUnit: "km", metricTarget: 100, remindersEnabled: false }).success).toBe(true);
    expect(createGoalSchema.safeParse({ ...goal, metricUnit: "km" }).success).toBe(false);
  });

  it("allows users to skip AI plan generation", () => {
    expect(createGoalSchema.parse({ ...goal, generatePlan: false }).generatePlan).toBe(false);
    expect(createGoalSchema.parse(goal).generatePlan).toBe(true);
  });

  it("accepts positive metric logs and per-action reminder controls", () => {
    expect(logGoalProgressSchema.safeParse({ value: 2.5, note: "Easy run" }).success).toBe(true);
    expect(logGoalProgressSchema.safeParse({ value: 0 }).success).toBe(false);
    expect(createActionSchema.safeParse({
      goalId: "cm12345678901234567890123",
      title: "Easy run",
      reminderEnabled: false,
    }).success).toBe(true);
  });
});
