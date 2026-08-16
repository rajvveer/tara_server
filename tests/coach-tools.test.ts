import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actionFindFirst: vi.fn(),
  actionUpdate: vi.fn(),
  actionCount: vi.fn(),
  progressCreate: vi.fn(),
  analyticsCreate: vi.fn(),
  milestoneUpdateMany: vi.fn(),
  userFindUniqueOrThrow: vi.fn(),
  userPreferenceUpsert: vi.fn(),
  goalCreate: vi.fn(),
  routineCreate: vi.fn(),
  notificationCreate: vi.fn(),
  generateRoutineActions: vi.fn(),
  transaction: vi.fn(),
}));

const transactionClient = {
  action: { update: mocks.actionUpdate, count: mocks.actionCount },
  progressRecord: { create: mocks.progressCreate },
  analyticsEvent: { create: mocks.analyticsCreate },
  milestone: { updateMany: mocks.milestoneUpdateMany },
  goal: { create: mocks.goalCreate },
  routine: { create: mocks.routineCreate },
  notification: { create: mocks.notificationCreate },
  userPreference: { upsert: mocks.userPreferenceUpsert },
};

vi.mock("../src/db.js", () => ({
  prisma: {
    action: { findFirst: mocks.actionFindFirst },
    user: { findUniqueOrThrow: mocks.userFindUniqueOrThrow },
    $transaction: mocks.transaction,
  },
}));

vi.mock("../src/maintenance.js", () => ({
  generateRoutineActions: mocks.generateRoutineActions,
}));

import { executeCoachTool } from "../src/coach-tools.js";

const task = {
  id: "cmsuacc9w005yl6h8untx6l2s",
  userId: "user-1",
  goalId: "goal-1",
  milestoneId: "milestone-1",
  title: "Take a walk",
  status: "UPCOMING",
  completedAt: null,
  skippedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actionFindFirst.mockResolvedValue(task);
  mocks.transaction.mockImplementation((callback) => callback(transactionClient));
  mocks.actionUpdate.mockResolvedValue({
    ...task,
    status: "COMPLETED",
    scheduledFor: new Date("2026-08-18T02:30:00.000Z"),
    goal: { id: "goal-1", title: "First 5K" },
    milestone: { id: "milestone-1", title: "First week" },
  });
  mocks.actionCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
  mocks.generateRoutineActions.mockResolvedValue(9);
});

describe("Tara coach tools", () => {
  it("completes an owned task through the shared action transition", async () => {
    const result = await executeCoachTool(
      "user-1",
      "update_task",
      JSON.stringify({ taskId: task.id, status: "COMPLETED" }),
      "Mark my walk complete",
    );

    expect(result.changed).toBe(true);
    expect(mocks.progressCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actionId: task.id, status: "COMPLETED" }),
    }));
    expect(mocks.milestoneUpdateMany).toHaveBeenCalled();
  });

  it("does not delete a task before a separate confirmation turn", async () => {
    const result = await executeCoachTool(
      "user-1",
      "delete_task",
      JSON.stringify({ taskId: task.id, confirmedByUser: true }),
      "Delete my walk task",
    );

    expect(result).toMatchObject({
      changed: false,
      content: { confirmationRequired: true, item: "Take a walk" },
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("does not mutate a task for a read-only coaching request", async () => {
    const result = await executeCoachTool(
      "user-1",
      "update_task",
      JSON.stringify({ taskId: task.id, status: "IN_PROGRESS" }),
      "I feel overwhelmed. Give me one small step.",
    );

    expect(result).toMatchObject({ changed: false, content: { error: expect.any(String) } });
    expect(mocks.actionUpdate).not.toHaveBeenCalled();
  });

  it("creates a goal and generates its task plan using saved schedule defaults", async () => {
    const goal = {
      id: "cmsuag6hkg4efyl5dvz8llocj",
      title: "Learn conversational Spanish",
      category: "LEARNING",
      status: "ACTIVE",
      targetDate: new Date("2026-11-15T00:00:00.000Z"),
    };
    mocks.userFindUniqueOrThrow.mockResolvedValue({
      preferences: { preferredDays: ["TUESDAY", "THURSDAY", "SATURDAY"], preferredTime: "08:00", workingFrequency: 3 },
    });
    mocks.goalCreate.mockResolvedValue(goal);
    mocks.routineCreate.mockResolvedValue({ id: "routine-1" });

    const result = await executeCoachTool(
      "user-1",
      "create_goal",
      JSON.stringify({ title: goal.title, category: goal.category, targetDate: goal.targetDate.toISOString() }),
      "Create a goal to learn conversational Spanish by November 15",
    );

    expect(result).toMatchObject({ changed: true, content: { goal: { id: goal.id }, generatedTaskCount: 9 } });
    expect(mocks.goalCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        preferredDays: ["TUESDAY", "THURSDAY", "SATURDAY"],
        preferredTime: "08:00",
        weeklyTarget: 3,
      }),
    }));
    expect(mocks.routineCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ goalId: goal.id, durationMinutes: 30, timesPerWeek: 3 }),
    }));
    expect(mocks.generateRoutineActions).toHaveBeenCalledWith(expect.any(Date), 21, goal.id);
    expect(mocks.notificationCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ dedupeKey: `goal:${goal.id}:created`, type: "SYSTEM" }),
    }));
  });

  it("keeps working frequency aligned with newly selected days", async () => {
    mocks.userFindUniqueOrThrow.mockResolvedValue({
      name: "Answer Audit",
      timezone: "Asia/Kolkata",
      preferences: { preferredDays: ["TUESDAY", "THURSDAY"], preferredTime: "18:15", workingFrequency: 2 },
    });

    await executeCoachTool(
      "user-1",
      "update_profile",
      JSON.stringify({ preferredDays: ["TUESDAY", "THURSDAY"], preferredTime: "18:15" }),
      "Use Tuesday and Thursday at 6:15 PM",
    );

    expect(mocks.userPreferenceUpsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ workingFrequency: 2 }),
    }));
  });
});
