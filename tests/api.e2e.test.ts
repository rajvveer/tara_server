import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run("API journey (PostgreSQL)", () => {
  let app: Server;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const marker = randomUUID().slice(0, 8);
  const first = { name: "API Test One", email: `api-one-${marker}@example.com`, password: "StrongPassword123!", timezone: "Asia/Kolkata" };
  const second = { name: "API Test Two", email: `api-two-${marker}@example.com`, password: "StrongPassword123!", timezone: "UTC" };
  let token = "";
  let secondToken = "";
  let firstUserId = "";
  let secondUserId = "";
  let goalId = "";
  let milestoneId = "";
  let actionId = "";

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = databaseUrl!;
    process.env.JWT_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
    process.env.GROQ_API_KEY = "";
    ({ prisma } = await import("../src/db.js"));
    const expressApp = (await import("../src/app.js")).app;
    app = expressApp.listen();
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({ where: { email: { in: [first.email, second.email] } } });
      await prisma.$disconnect();
    }
    if (app) await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
  });

  it("registers and logs in two users", async () => {
    const registered = await request(app).post("/api/v1/auth/register").send(first).expect(201);
    expect(registered.body.data.user.passwordHash).toBeUndefined();
    expect(registered.body.data.accessToken).toEqual(expect.any(String));
    token = registered.body.data.accessToken;
    firstUserId = registered.body.data.user.id;

    const other = await request(app).post("/api/v1/auth/register").send(second).expect(201);
    secondToken = other.body.data.accessToken;
    secondUserId = other.body.data.user.id;

    const loggedIn = await request(app).post("/api/v1/auth/login").send({ email: first.email, password: first.password }).expect(200);
    expect(loggedIn.body.data.user.id).toBe(firstUserId);
    expect(loggedIn.body.data.refreshToken).toEqual(expect.any(String));
  });

  it("completes onboarding by creating the first goal, routine, and push device", async () => {
    const firstGoalId = `c${randomUUID().replaceAll("-", "")}`;
    const onboarded = await request(app).post("/api/v1/users/me/onboarding").set("Authorization", `Bearer ${token}`).send({
      mainObjective: "Build a reliable weekly rhythm",
      avatarKey: "woman-blue-teal",
      preferences: {
        preferredDays: ["MONDAY", "WEDNESDAY", "FRIDAY"],
        preferredTime: "19:00",
        workingFrequency: 3,
        personalConstraints: "No work meetings after 7 PM",
        progressStyle: "DETAILED",
        weekStartsOn: 1,
      },
      firstGoal: {
        id: firstGoalId,
        title: "Build a reliable weekly rhythm",
        targetDate: "2026-12-31T00:00:00.000Z",
        frequency: "WEEKLY",
        preferredDays: ["MONDAY", "WEDNESDAY", "FRIDAY"],
        preferredTime: "19:00",
        weeklyTarget: 3,
      },
    }).expect(200);
    expect(onboarded.body.data.goal).toMatchObject({ id: firstGoalId, title: "Build a reliable weekly rhythm" });
    expect(onboarded.body.data.user.avatarKey).toBe("woman-blue-teal");
    expect(await prisma.routine.count({ where: { goalId: firstGoalId, isActive: true } })).toBe(1);

    const pushToken = `e2e-${marker}`.padEnd(40, "x");
    await request(app).post("/api/v1/notifications/devices").set("Authorization", `Bearer ${token}`).send({ token: pushToken, platform: "android" }).expect(201);
    expect(await prisma.pushDevice.count({ where: { userId: firstUserId, token: pushToken, enabled: true } })).toBe(1);
  });

  it("lists due notifications and keeps read state scoped to visible items", async () => {
    const visible = await prisma.notification.create({ data: {
      userId: firstUserId,
      type: "SYSTEM",
      title: "Visible now",
      body: "This belongs in the inbox.",
      scheduledAt: new Date(Date.now() - 60_000),
    } });
    const future = await prisma.notification.create({ data: {
      userId: firstUserId,
      type: "SYSTEM",
      title: "Visible later",
      body: "This must stay hidden until it is due.",
      scheduledAt: new Date(Date.now() + 86_400_000),
    } });

    const listed = await request(app).get("/api/v1/notifications").set("Authorization", `Bearer ${token}`).expect(200);
    expect(listed.body.data.map((item: { id: string }) => item.id)).toContain(visible.id);
    expect(listed.body.data.map((item: { id: string }) => item.id)).not.toContain(future.id);
    expect(listed.body.meta.unread).toBeGreaterThanOrEqual(1);

    await request(app).patch(`/api/v1/notifications/${visible.id}/read`).set("Authorization", `Bearer ${token}`).send({}).expect(200);
    await request(app).patch(`/api/v1/notifications/${future.id}/read`).set("Authorization", `Bearer ${token}`).send({}).expect(404);

    const secondVisible = await prisma.notification.create({ data: {
      userId: firstUserId,
      type: "SYSTEM",
      title: "Another visible item",
      body: "Mark all should include this item.",
    } });
    const marked = await request(app).post("/api/v1/notifications/read-all").set("Authorization", `Bearer ${token}`).expect(200);
    expect(marked.body.data.updated).toBeGreaterThanOrEqual(1);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: secondVisible.id } })).readAt).not.toBeNull();
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: future.id } })).readAt).toBeNull();
  });

  it("rejects an invalid plan without persisting partial goal data", async () => {
    const goalsBefore = await prisma.goal.count({ where: { userId: firstUserId } });
    const rejected = await request(app).post("/api/v1/goals").set("Authorization", `Bearer ${token}`).send({
      title: "Never persists",
      category: "PERSONAL",
      startDate: "2026-08-12T00:00:00.000Z",
      plan: {
        milestones: [{ title: "Never persists" }],
        actions: [{ title: "   " }],
        routine: { name: "Never persists", durationMinutes: 20 },
      },
    }).expect(422);
    expect(rejected.body.error.code).toBe("VALIDATION_ERROR");

    const counts = await Promise.all([
      prisma.goal.count({ where: { userId: firstUserId } }),
      prisma.milestone.count({ where: { userId: firstUserId, title: "Never persists" } }),
      prisma.action.count({ where: { userId: firstUserId, title: "Never persists" } }),
      prisma.routine.count({ where: { userId: firstUserId, name: "Never persists" } }),
    ]);
    expect(counts).toEqual([goalsBefore, 0, 0, 0]);
  });

  it("creates a goal without generated actions when AI planning is off", async () => {
    const goal = await request(app).post("/api/v1/goals").set("Authorization", `Bearer ${token}`).send({
      title: "Keep this goal manual",
      category: "PERSONAL",
      startDate: "2026-08-12T00:00:00.000Z",
      frequency: "WEEKLY",
      weeklyTarget: 1,
      preferredDays: ["MONDAY"],
      generatePlan: false,
      plan: { routine: { name: "Manual rhythm", durationMinutes: 20 } },
    }).expect(201);

    expect(goal.body.data.actions).toEqual([]);
  });

  it("creates a goal and full plan atomically", async () => {
    const plannedMilestoneId = `c${randomUUID().replaceAll("-", "")}`;
    const goal = await request(app).post("/api/v1/goals").set("Authorization", `Bearer ${token}`).send({
      title: "Ship the integration journey",
      category: "PRODUCTIVITY",
      startDate: "2026-08-12T00:00:00.000Z",
      targetDate: null,
      frequency: "WEEKLY",
      weeklyTarget: 3,
      preferredDays: ["MONDAY", "WEDNESDAY", "FRIDAY"],
      metricUnit: "hours",
      metricTarget: 100,
      remindersEnabled: false,
      plan: {
        milestones: [{ id: plannedMilestoneId, title: "Core flow works", targetDate: "2026-08-26T00:00:00.000Z" }],
        actions: [
          { title: "Complete this", milestoneId: plannedMilestoneId, scheduledFor: "2026-08-12T08:00:00.000Z", estimatedMinutes: 25, reminderEnabled: false },
          { title: "Skip this", scheduledFor: "2026-08-12T09:00:00.000Z", estimatedMinutes: 25 },
        ],
        routine: { name: "Keep this routine", durationMinutes: 25 },
      },
    }).expect(201);

    goalId = goal.body.data.id;
    milestoneId = goal.body.data.milestones[0].id;
    actionId = goal.body.data.actions.find((action: { title: string }) => action.title === "Complete this").id;
    expect(goal.body.data).toMatchObject({
      title: "Ship the integration journey",
      targetDate: null,
      metricUnit: "hours",
      metricTarget: 100,
      metricCurrent: 0,
      remindersEnabled: false,
      milestones: [expect.objectContaining({ title: "Core flow works" })],
      routines: [expect.objectContaining({ name: "Keep this routine", frequency: "WEEKLY", days: ["MONDAY", "WEDNESDAY", "FRIDAY"], timesPerWeek: 3, durationMinutes: 25 })],
      progressRecords: [],
    });
    expect(goal.body.data.actions.map((action: { title: string }) => action.title)).toEqual(expect.arrayContaining(["Complete this", "Skip this"]));
    expect(new Set(goal.body.data.actions.map((action: { title: string }) => action.title)).size).toBe(goal.body.data.actions.length);
    expect(goal.body.data.actions.some((action: { title: string }) => action.title.startsWith("Continue "))).toBe(false);
    expect(goal.body.data.actions.find((action: { id: string }) => action.id === actionId).milestoneId).toBe(milestoneId);
    expect(goal.body.data.actions.find((action: { id: string }) => action.id === actionId).reminderEnabled).toBe(false);
    expect(await prisma.notification.findUnique({ where: { dedupeKey: `goal:${goalId}:created` } })).toMatchObject({
      userId: firstUserId,
      type: "SYSTEM",
      title: "Goal created",
    });
  });

  it("logs custom numeric progress with history", async () => {
    const logged = await request(app)
      .post(`/api/v1/goals/${goalId}/progress`)
      .set("Authorization", `Bearer ${token}`)
      .send({ value: 12.5, note: "Focused work" })
      .expect(201);

    expect(logged.body.data.goal.metricCurrent).toBe(12.5);
    expect(logged.body.data.goal.progress.progress).toBe(13);
    expect(logged.body.data.record).toMatchObject({
      goalId,
      actionId: null,
      status: "IN_PROGRESS",
      value: 12.5,
      note: "Focused work",
    });
  });

  it("generates recurring actions and automatically marks overdue work missed", async () => {
    const { generateRoutineActions, markOverdueActionsMissed } = await import("../src/maintenance.js");
    const now = new Date(Date.now() + 22 * 86_400_000);
    expect(await generateRoutineActions(now, 7)).toBeGreaterThan(0);
    expect(await prisma.action.count({ where: { goalId, routineId: { not: null } } })).toBeGreaterThan(2);

    const overdue = await prisma.action.create({
      data: {
        userId: firstUserId,
        goalId,
        title: "Automatically missed",
        status: "UPCOMING",
        scheduledFor: new Date("2026-08-10T08:00:00.000Z"),
        dueDate: new Date("2026-08-10T08:00:00.000Z"),
      },
    });
    expect(await markOverdueActionsMissed(now)).toBeGreaterThan(0);
    expect((await prisma.action.findUniqueOrThrow({ where: { id: overdue.id } })).status).toBe("MISSED");
  });

  it("keeps active routines aligned when a goal schedule changes", async () => {
    const goal = await request(app).patch(`/api/v1/goals/${goalId}`).set("Authorization", `Bearer ${token}`).send({
      frequency: "CUSTOM",
      preferredDays: ["TUESDAY", "THURSDAY"],
      preferredTime: "07:15",
      weeklyTarget: 2,
    }).expect(200);
    const routines = await request(app).get(`/api/v1/routines?goalId=${goalId}&active=true`).set("Authorization", `Bearer ${token}`).expect(200);

    expect(goal.body.data).toMatchObject({ frequency: "CUSTOM", preferredDays: ["TUESDAY", "THURSDAY"], preferredTime: "07:15", weeklyTarget: 2 });
    expect(routines.body.data).toEqual([
      expect.objectContaining({ name: "Keep this routine", frequency: "CUSTOM", days: ["TUESDAY", "THURSDAY"], preferredTime: "07:15", timesPerWeek: 2, durationMinutes: 25, isActive: true }),
    ]);
  });

  it("preserves UTC-midnight calendar days for an IST user", async () => {
    const goal = await request(app).get(`/api/v1/goals/${goalId}`).set("Authorization", `Bearer ${token}`).expect(200);
    const reflection = await request(app).post("/api/v1/reflections").set("Authorization", `Bearer ${token}`).send({
      periodStart: "2026-08-10T00:00:00.000Z",
      periodEnd: "2026-08-16T00:00:00.000Z",
    }).expect(201);

    expect([
      goal.body.data.startDate,
      goal.body.data.milestones.find((item: { id: string }) => item.id === milestoneId).targetDate,
      reflection.body.data.periodStart,
      reflection.body.data.periodEnd,
      goal.body.data.actions.find((item: { id: string }) => item.id === actionId).scheduledFor,
    ]).toEqual([
      "2026-08-12T00:00:00.000Z",
      "2026-08-26T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z",
      "2026-08-16T00:00:00.000Z",
      "2026-08-12T08:00:00.000Z",
    ]);
  });

  it("completes and skips actions while preserving history", async () => {
    expect((await request(app).post(`/api/v1/actions/${actionId}/start`).set("Authorization", `Bearer ${token}`).expect(200)).body.data.status).toBe("IN_PROGRESS");
    expect((await request(app).post(`/api/v1/actions/${actionId}/miss`).set("Authorization", `Bearer ${token}`).expect(200)).body.data.status).toBe("MISSED");
    expect((await request(app).post(`/api/v1/actions/${actionId}/reopen`).set("Authorization", `Bearer ${token}`).expect(200)).body.data.status).toBe("UPCOMING");
    const completed = await request(app).post(`/api/v1/actions/${actionId}/complete`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(completed.body.data.status).toBe("COMPLETED");
    expect((await prisma.milestone.findUniqueOrThrow({ where: { id: milestoneId } })).status).toBe("UPCOMING");
    const remainingMilestoneActions = await prisma.action.findMany({
      where: { milestoneId, id: { not: actionId }, deletedAt: null },
      select: { id: true },
    });
    for (const action of remainingMilestoneActions) {
      await request(app).post(`/api/v1/actions/${action.id}/complete`).set("Authorization", `Bearer ${token}`).expect(200);
    }
    expect((await prisma.milestone.findUniqueOrThrow({ where: { id: milestoneId } })).status).toBe("COMPLETED");
    await request(app).post(`/api/v1/actions/${actionId}/reopen`).set("Authorization", `Bearer ${token}`).expect(200);
    expect((await prisma.milestone.findUniqueOrThrow({ where: { id: milestoneId } })).status).toBe("UPCOMING");
    await request(app).post(`/api/v1/actions/${actionId}/complete`).set("Authorization", `Bearer ${token}`).expect(200);
    const actions = await request(app).get(`/api/v1/actions?goalId=${goalId}`).set("Authorization", `Bearer ${token}`).expect(200);
    const toSkip = actions.body.data.find((item: { title: string }) => item.title === "Skip this");
    const skipped = await request(app).post(`/api/v1/actions/${toSkip.id}/skip`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(skipped.body.data.status).toBe("SKIPPED");
    const progress = await request(app).get(`/api/v1/progress/goals/${goalId}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(progress.body.data.history.map((item: { status: string }) => item.status)).toEqual(expect.arrayContaining(["IN_PROGRESS", "MISSED", "UPCOMING", "COMPLETED", "SKIPPED"]));
    const history = await request(app).get("/api/v1/progress/history").set("Authorization", `Bearer ${token}`).expect(200);
    expect(history.body.data.history.some((item: { actionId: string; status: string }) => item.actionId === actionId && item.status === "COMPLETED")).toBe(true);
  });

  it("prevents cross-user reads and writes", async () => {
    await request(app).get(`/api/v1/goals/${goalId}`).set("Authorization", `Bearer ${secondToken}`).expect(404);
    await request(app).patch(`/api/v1/actions/${actionId}`).set("Authorization", `Bearer ${secondToken}`).send({ title: "Stolen" }).expect(404);
    const unchanged = await prisma.action.findFirstOrThrow({ where: { id: actionId, userId: firstUserId } });
    expect(unchanged.title).toBe("Complete this");
    expect(secondUserId).not.toBe(firstUserId);
  });

  it("keeps actions visible by unassigning them when a milestone is deleted", async () => {
    await request(app).delete(`/api/v1/milestones/${milestoneId}`).set("Authorization", `Bearer ${token}`).expect(204);
    expect((await prisma.action.findUniqueOrThrow({ where: { id: actionId } })).milestoneId).toBeNull();
  });

  it("exports only the authenticated user without credential material", async () => {
    await prisma.analyticsEvent.create({ data: { userId: secondUserId, name: `other-user-${marker}` } });
    const exported = await request(app).get("/api/v1/users/me/export").set("Authorization", `Bearer ${token}`).expect(200);
    const serialized = JSON.stringify(exported.body.data);
    const keyNames = new Set<string>();
    const collectKeys = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        keyNames.add(key);
        collectKeys(child);
      }
    };
    collectKeys(exported.body.data);

    expect(exported.body.data.account).toMatchObject({ id: firstUserId, email: first.email, timezone: "Asia/Kolkata" });
    expect(exported.body.data.goals.some((goal: { id: string }) => goal.id === goalId)).toBe(true);
    expect(keyNames).not.toContain("passwordHash");
    expect(keyNames).not.toContain("tokenHash");
    expect(keyNames).not.toContain("sessions");
    expect(keyNames).not.toContain("passwordResetTokens");
    expect(serialized).not.toContain(second.email);
    expect(serialized).not.toContain(`other-user-${marker}`);
  });

  it("retires child work atomically when a goal is deleted", async () => {
    const progressBefore = await prisma.progressRecord.count({ where: { goalId } });
    await request(app).delete(`/api/v1/goals/${goalId}`).set("Authorization", `Bearer ${token}`).expect(204);

    const [goal, actions, milestones, routines, progressAfter] = await Promise.all([
      prisma.goal.findUniqueOrThrow({ where: { id: goalId } }),
      prisma.action.findMany({ where: { goalId } }),
      prisma.milestone.findMany({ where: { goalId } }),
      prisma.routine.findMany({ where: { goalId } }),
      prisma.progressRecord.count({ where: { goalId } }),
    ]);
    expect(goal.status).toBe("ARCHIVED");
    expect(goal.deletedAt).not.toBeNull();
    expect(actions.every((action) => action.deletedAt?.getTime() === goal.deletedAt?.getTime())).toBe(true);
    expect(milestones.every((milestone) => milestone.deletedAt != null)).toBe(true);
    expect(routines.every((routine) => !routine.isActive)).toBe(true);
    expect(progressAfter).toBe(progressBefore);

    const listed = await request(app).get(`/api/v1/actions?goalId=${goalId}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(listed.body.data).toEqual([]);
    await request(app).post(`/api/v1/actions/${actionId}/complete`).set("Authorization", `Bearer ${token}`).expect(404);
  });

  it("deletes an account and cascades all owned data", async () => {
    const ownedBefore = await Promise.all([
      prisma.user.count({ where: { id: firstUserId } }),
      prisma.goal.count({ where: { userId: firstUserId } }),
      prisma.reflection.count({ where: { userId: firstUserId } }),
      prisma.analyticsEvent.count({ where: { userId: firstUserId } }),
      prisma.session.count({ where: { userId: firstUserId } }),
    ]);
    expect(ownedBefore.every((count) => count > 0)).toBe(true);

    await request(app).delete("/api/v1/users/me").set("Authorization", `Bearer ${token}`).expect(204);
    const ownedAfter = await Promise.all([
      prisma.user.count({ where: { id: firstUserId } }),
      prisma.goal.count({ where: { userId: firstUserId } }),
      prisma.milestone.count({ where: { userId: firstUserId } }),
      prisma.action.count({ where: { userId: firstUserId } }),
      prisma.routine.count({ where: { userId: firstUserId } }),
      prisma.progressRecord.count({ where: { userId: firstUserId } }),
      prisma.reflection.count({ where: { userId: firstUserId } }),
      prisma.notification.count({ where: { userId: firstUserId } }),
      prisma.analyticsEvent.count({ where: { userId: firstUserId } }),
      prisma.session.count({ where: { userId: firstUserId } }),
    ]);
    expect(ownedAfter).toEqual(Array(10).fill(0));
    await request(app).get("/api/v1/users/me/export").set("Authorization", `Bearer ${token}`).expect(404);
    await request(app).get("/api/v1/users/me/export").set("Authorization", `Bearer ${secondToken}`).expect(200);
  });
});
