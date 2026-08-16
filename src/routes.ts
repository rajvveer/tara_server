import { Router, urlencoded } from "express";
import bcrypt from "bcryptjs";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { ApiError, validate } from "./errors.js";
import {
  issueSession,
  newPasswordResetToken,
  passwordResetHash,
  requireAuth,
  revokeSession,
  rotateSession,
} from "./auth.js";
import { config } from "./config.js";
import { calculateGoalProgress, timezoneDayRange, timezoneMonthRange, timezoneWeekRange } from "./goal-progress.js";
import { verifyAppleAuthorization, verifyGoogleIdToken, type SocialIdentity } from "./social-auth.js";
import * as schemas from "./schemas.js";
import { sendPasswordResetEmail } from "./email.js";
import { startVoiceOnboarding, voiceOnboardingTurn } from "./sarvam.js";
import { generateRoutineActions } from "./maintenance.js";
import { ownedAction, syncMilestoneCompletion, transitionAction } from "./action-service.js";
import { queueGoalCreatedNotification } from "./push.js";

const router = Router();

const publicUser = {
  id: true,
  name: true,
  email: true,
  profileImageUrl: true,
  avatarKey: true,
  timezone: true,
  mainObjective: true,
  onboardingCompleted: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

const metadata = (request: { get(name: string): string | undefined; ip?: string }) => ({
  userAgent: request.get("user-agent")?.slice(0, 500),
  ipAddress: request.ip?.slice(0, 64),
});

async function socialAccount(identity: SocialIdentity, timezone: string) {
  return prisma.$transaction(async (transaction) => {
    const bySubject = identity.provider === "google"
      ? await transaction.user.findUnique({ where: { googleSubject: identity.subject }, select: publicUser })
      : await transaction.user.findUnique({ where: { appleSubject: identity.subject }, select: publicUser });
    if (bySubject) return bySubject;
    if (!identity.email) throw new ApiError(401, "PROVIDER_ACCOUNT_INCOMPLETE", "This provider account did not share the information needed to create an account.");

    const byEmail = await transaction.user.findUnique({
      where: { email: identity.email },
      select: { ...publicUser, googleSubject: true, appleSubject: true },
    });
    const subjectData = identity.provider === "google"
      ? { googleSubject: identity.subject }
      : { appleSubject: identity.subject };

    if (byEmail) {
      if (!identity.canAutoLinkEmail) {
        throw new ApiError(409, "ACCOUNT_LINK_REQUIRED", "Sign in with your existing method before linking this provider.");
      }
      const linkedSubject = identity.provider === "google" ? byEmail.googleSubject : byEmail.appleSubject;
      if (linkedSubject && linkedSubject !== identity.subject) {
        throw new ApiError(409, "PROVIDER_ALREADY_LINKED", "This account is already linked to a different provider identity.");
      }
      return transaction.user.update({ where: { id: byEmail.id }, data: subjectData, select: publicUser });
    }

    const created = await transaction.user.create({
      data: {
        email: identity.email,
        name: identity.suggestedName ?? "GoalSpring member",
        passwordHash: null,
        profileImageUrl: identity.profileImageUrl,
        timezone,
        ...subjectData,
      },
      select: publicUser,
    });
    await transaction.userPreference.create({ data: { userId: created.id, preferredDays: [] } });
    await transaction.notificationPreference.create({ data: { userId: created.id } });
    await transaction.analyticsEvent.create({ data: { userId: created.id, name: "account_created", properties: { provider: identity.provider } } });
    return created;
  });
}

async function ownedGoal(userId: string, id: string) {
  const goal = await prisma.goal.findFirst({ where: { id, userId, deletedAt: null } });
  if (!goal) throw new ApiError(404, "GOAL_NOT_FOUND", "Goal not found.");
  return goal;
}

async function assertMilestone(userId: string, goalId: string, milestoneId?: string | null) {
  if (!milestoneId) return;
  const milestone = await prisma.milestone.findFirst({ where: { id: milestoneId, userId, goalId, deletedAt: null } });
  if (!milestone) throw new ApiError(422, "INVALID_MILESTONE", "Milestone does not belong to this goal.");
}

router.post("/auth/register", validate(schemas.registerSchema), async (request, response) => {
  const { password, ...input } = request.body;
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.$transaction(async (transaction) => {
    const created = await transaction.user.create({ data: { ...input, passwordHash }, select: publicUser });
    await transaction.userPreference.create({ data: { userId: created.id, preferredDays: [] } });
    await transaction.notificationPreference.create({ data: { userId: created.id } });
    await transaction.analyticsEvent.create({ data: { userId: created.id, name: "account_created" } });
    return created;
  });
  const tokens = await issueSession(user.id, metadata(request));
  response.status(201).json({ data: { user, ...tokens } });
});

router.post("/auth/login", validate(schemas.loginSchema), async (request, response) => {
  const userWithPassword = await prisma.user.findUnique({ where: { email: request.body.email } });
  const fallbackHash = "$2b$12$C6UzMDM.H6dfI/f/IKcEe.5e5f4gULPPxO5v5S5v5S5v5S5v5S5v";
  const valid = await bcrypt.compare(request.body.password, userWithPassword?.passwordHash ?? fallbackHash);
  if (!userWithPassword || !valid) throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userWithPassword.id }, select: publicUser });
  const tokens = await issueSession(user.id, metadata(request));
  response.json({ data: { user, ...tokens } });
});

router.post("/auth/google", validate(schemas.googleAuthSchema), async (request, response) => {
  const user = await socialAccount(await verifyGoogleIdToken(request.body.idToken), request.body.timezone);
  const tokens = await issueSession(user.id, metadata(request));
  response.json({ data: { user, ...tokens } });
});

router.post("/auth/apple", validate(schemas.appleAuthSchema), async (request, response) => {
  const { timezone, ...credentials } = request.body;
  const user = await socialAccount(await verifyAppleAuthorization(credentials), timezone);
  const tokens = await issueSession(user.id, metadata(request));
  response.json({ data: { user, ...tokens } });
});

router.post(
  "/auth/apple/callback",
  (request, _response, next) => request.is("application/x-www-form-urlencoded")
    ? next()
    : next(new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Apple callbacks must use form encoding.")),
  urlencoded({ extended: false, limit: "32kb", parameterLimit: 8 }),
  validate(schemas.appleCallbackSchema),
  (request, response) => {
    const query = new URLSearchParams();
    for (const field of ["code", "id_token", "state", "user", "error", "error_description"] as const) {
      const value = request.body[field];
      if (typeof value === "string") query.set(field, value);
    }
    const location = `intent://callback?${query.toString()}#Intent;package=${config.APPLE_ANDROID_PACKAGE};scheme=signinwithapple;end`;
    response.status(303).set({
      Location: location,
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "Referrer-Policy": "no-referrer",
    }).end();
  },
);

router.post("/auth/refresh", validate(schemas.refreshSchema), async (request, response) => {
  response.json({ data: await rotateSession(request.body.refreshToken, metadata(request)) });
});

router.post("/auth/logout", validate(schemas.refreshSchema), async (request, response) => {
  await revokeSession(request.body.refreshToken);
  response.status(204).send();
});

router.post("/auth/forgot-password", validate(schemas.forgotPasswordSchema), async (request, response) => {
  const user = await prisma.user.findUnique({ where: { email: request.body.email }, select: { id: true, email: true } });
  let developmentResetToken: string | undefined;
  if (user) {
    const { token, tokenHash } = newPasswordResetToken();
    await prisma.$transaction([
      prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } }),
      prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 3_600_000) } }),
    ]);
    if (config.NODE_ENV !== "production" && !config.RESEND_API_KEY) developmentResetToken = token;
    else await sendPasswordResetEmail(user.email, token);
  }
  response.json({ data: { message: "If that account exists, password reset instructions have been sent.", ...(developmentResetToken ? { developmentResetToken } : {}) } });
});

router.post("/auth/reset-password", validate(schemas.resetPasswordSchema), async (request, response) => {
  const token = await prisma.passwordResetToken.findUnique({ where: { tokenHash: passwordResetHash(request.body.token) } });
  if (!token || token.usedAt || token.expiresAt <= new Date()) throw new ApiError(400, "INVALID_RESET_TOKEN", "This password reset link is invalid or expired.");
  const passwordHash = await bcrypt.hash(request.body.password, 12);
  await prisma.$transaction([
    prisma.user.update({ where: { id: token.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: token.id }, data: { usedAt: new Date() } }),
    prisma.session.deleteMany({ where: { userId: token.userId } }),
  ]);
  response.json({ data: { message: "Password updated. Please sign in again." } });
});

router.use(requireAuth);

router.post("/voice/onboarding/start", validate(schemas.voiceStartSchema), async (request, response) => {
  response.json({ data: await startVoiceOnboarding(request.body.locale, request.body.name) });
});

router.post("/voice/onboarding/turn", validate(schemas.voiceTurnSchema), async (request, response) => {
  response.json({ data: await voiceOnboardingTurn(request.body) });
});

router.get("/users/me", async (request, response) => {
  const user = await prisma.user.findUnique({ where: { id: request.userId! }, select: { ...publicUser, preferences: true, notificationPrefs: true } });
  if (!user) throw new ApiError(404, "USER_NOT_FOUND", "User not found.");
  response.json({ data: user });
});

router.patch("/users/me", validate(schemas.profileSchema), async (request, response) => {
  const user = await prisma.user.update({ where: { id: request.userId! }, data: request.body, select: publicUser });
  response.json({ data: user });
});

router.get("/users/me/export", async (request, response) => {
  const account = await prisma.user.findUnique({
    where: { id: request.userId! },
    select: { ...publicUser, preferences: true, notificationPrefs: true },
  });
  if (!account) throw new ApiError(404, "USER_NOT_FOUND", "User not found.");

  const [goals, reflections, notifications, analyticsEvents] = await Promise.all([
    prisma.goal.findMany({
      where: { userId: request.userId! },
      include: {
        milestones: { orderBy: { position: "asc" } },
        actions: { orderBy: { createdAt: "asc" } },
        routines: { orderBy: { createdAt: "asc" } },
        progressRecords: { orderBy: { occurredAt: "asc" } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.reflection.findMany({ where: { userId: request.userId! }, orderBy: { periodStart: "asc" } }),
    prisma.notification.findMany({ where: { userId: request.userId! }, orderBy: { createdAt: "asc" } }),
    prisma.analyticsEvent.findMany({ where: { userId: request.userId! }, orderBy: { createdAt: "asc" } }),
  ]);

  const { notificationPrefs, ...profile } = account;
  response.json({
    data: {
      exportedAt: new Date().toISOString(),
      account: { ...profile, notificationPreferences: notificationPrefs },
      goals,
      reflections,
      notifications,
      analyticsEvents,
    },
  });
});

router.delete("/users/me", async (request, response) => {
  const deleted = await prisma.user.deleteMany({ where: { id: request.userId! } });
  if (deleted.count === 0) throw new ApiError(404, "USER_NOT_FOUND", "User not found.");
  response.status(204).send();
});

router.get("/users/me/preferences", async (request, response) => {
  const preferences = await prisma.userPreference.findUnique({ where: { userId: request.userId! } });
  response.json({ data: preferences });
});

router.patch("/users/me/preferences", validate(schemas.preferencesSchema), async (request, response) => {
  const preferences = await prisma.userPreference.upsert({
    where: { userId: request.userId! },
    create: { userId: request.userId!, preferredDays: [], ...request.body },
    update: request.body,
  });
  response.json({ data: preferences });
});

router.post("/users/me/onboarding", validate(schemas.onboardingSchema), async (request, response) => {
  const result = await prisma.$transaction(async (transaction) => {
    const user = await transaction.user.update({ where: { id: request.userId! }, data: { name: request.body.name, profileImageUrl: request.body.profileImageUrl, mainObjective: request.body.mainObjective, avatarKey: request.body.avatarKey, onboardingCompleted: true }, select: publicUser });
    const preferences = await transaction.userPreference.upsert({
      where: { userId: request.userId! },
      create: { userId: request.userId!, preferredDays: [], ...request.body.preferences },
      update: request.body.preferences,
    });
    const input = request.body.firstGoal;
    const existing = await transaction.goal.findFirst({ where: { id: input.id, userId: request.userId!, deletedAt: null } });
    const goal = existing ?? await transaction.goal.create({ data: {
      id: input.id,
      userId: request.userId!,
      title: input.title,
      description: "Your first direction from onboarding. Add milestones and actions when you are ready.",
      category: "PERSONAL",
      priority: "MEDIUM",
      startDate: new Date(),
      targetDate: input.targetDate,
      frequency: input.frequency,
      preferredDays: input.preferredDays,
      preferredTime: input.preferredTime,
      weeklyTarget: input.weeklyTarget,
      routines: { create: { userId: request.userId!, name: `${input.title} rhythm`, frequency: input.frequency, days: input.preferredDays, preferredTime: input.preferredTime, timesPerWeek: input.weeklyTarget, durationMinutes: 30 } },
    } });
    if (!existing) {
      await transaction.analyticsEvent.create({ data: { userId: request.userId!, name: "goal_created", properties: { goalId: goal.id, category: goal.category, source: "onboarding" } } });
      await queueGoalCreatedNotification(transaction, request.userId!, goal);
    }
    const detailed = await transaction.goal.findUniqueOrThrow({ where: { id: goal.id }, include: { milestones: true, actions: true, routines: { where: { isActive: true } }, progressRecords: { include: { action: { select: { id: true, title: true } } } } } });
    return { user, preferences, goal: { ...detailed, progress: calculateGoalProgress(detailed, detailed.actions) } };
  });
  await generateRoutineActions(new Date(), 21, result.goal.id);
  const detailed = await prisma.goal.findUniqueOrThrow({ where: { id: result.goal.id }, include: { milestones: true, actions: { where: { deletedAt: null }, orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }] }, routines: { where: { isActive: true } }, progressRecords: { include: { action: { select: { id: true, title: true } } } } } });
  response.json({ data: { ...result, goal: { ...detailed, progress: calculateGoalProgress(detailed, detailed.actions) } } });
});

router.get("/goals", validate(schemas.goalListQuery, "query"), async (request, response) => {
  const { page, limit, status, category } = request.query as unknown as { page: number; limit: number; status?: Prisma.EnumGoalStatusFilter; category?: Prisma.EnumGoalCategoryFilter };
  const where: Prisma.GoalWhereInput = { userId: request.userId!, deletedAt: null, ...(status ? { status } : {}), ...(category ? { category } : {}) };
  const [goals, total] = await prisma.$transaction([
    prisma.goal.findMany({
      where,
      include: { actions: { where: { deletedAt: null }, select: { status: true, scheduledFor: true, dueDate: true } }, _count: { select: { milestones: { where: { deletedAt: null } }, routines: { where: { isActive: true } } } } },
      orderBy: [{ status: "asc" }, { priority: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.goal.count({ where }),
  ]);
  response.json({ data: goals.map(({ actions, ...goal }) => ({ ...goal, progress: calculateGoalProgress(goal, actions) })), meta: { page, limit, total, pages: Math.ceil(total / limit) } });
});

router.post("/goals", validate(schemas.createGoalSchema), async (request, response) => {
  const { plan, generatePlan, ...goalInput } = request.body;
  const goalId = await prisma.$transaction(async (transaction) => {
    const created = await transaction.goal.create({ data: { ...goalInput, userId: request.userId! } });

    if (plan?.milestones?.length) {
      await transaction.milestone.createMany({
        data: plan.milestones.map((milestone: Record<string, unknown>, position: number) => ({ ...milestone, position, userId: request.userId!, goalId: created.id })),
      });
    }
    let routineId: string | undefined;
    if (plan?.routine) {
      const routine = await transaction.routine.create({
        data: {
          ...plan.routine,
          userId: request.userId!,
          goalId: created.id,
          frequency: plan.routine.frequency ?? created.frequency,
          days: plan.routine.days ?? created.preferredDays,
          preferredTime: plan.routine.preferredTime === undefined ? created.preferredTime : plan.routine.preferredTime,
          timesPerWeek: plan.routine.timesPerWeek === undefined ? created.weeklyTarget : plan.routine.timesPerWeek,
        },
      });
      routineId = routine.id;
    }
    if (plan?.actions?.length) {
      await transaction.action.createMany({
        data: plan.actions.map((action: Record<string, unknown>) => ({ ...action, userId: request.userId!, goalId: created.id, routineId })),
      });
    }

    await transaction.analyticsEvent.create({ data: { userId: request.userId!, name: "goal_created", properties: { goalId: created.id, category: created.category } } });
    await queueGoalCreatedNotification(transaction, request.userId!, created);
    return created.id;
  });
  if (generatePlan) await generateRoutineActions(new Date(), 7, goalId);
  const goal = await prisma.goal.findUniqueOrThrow({
    where: { id: goalId },
    include: {
      milestones: { where: { deletedAt: null }, orderBy: { position: "asc" }, include: { actions: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } } } },
      actions: { where: { deletedAt: null }, orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }] },
      routines: { where: { isActive: true }, orderBy: { createdAt: "asc" } },
      progressRecords: { include: { action: { select: { id: true, title: true } } }, orderBy: { occurredAt: "desc" }, take: 50 },
    },
  });
  response.status(201).json({ data: { ...goal, progress: calculateGoalProgress(goal, goal.actions) } });
});

router.get("/goals/:id", validate(schemas.idParams, "params"), async (request, response) => {
  const goal = await prisma.goal.findFirst({
    where: { id: request.params.id as string, userId: request.userId!, deletedAt: null },
    include: {
      milestones: { where: { deletedAt: null }, orderBy: { position: "asc" }, include: { actions: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } } } },
      actions: { where: { deletedAt: null }, orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }] },
      routines: { where: { isActive: true }, orderBy: { createdAt: "asc" } },
      progressRecords: { include: { action: { select: { id: true, title: true } } }, orderBy: { occurredAt: "desc" }, take: 50 },
    },
  });
  if (!goal) throw new ApiError(404, "GOAL_NOT_FOUND", "Goal not found.");
  response.json({ data: { ...goal, progress: calculateGoalProgress(goal, goal.actions) } });
});

router.patch("/goals/:id", validate(schemas.idParams, "params"), validate(schemas.updateGoalSchema), async (request, response) => {
  const current = await ownedGoal(request.userId!, request.params.id as string);
  const startDate = request.body.startDate ?? current.startDate;
  const targetDate = request.body.targetDate === undefined ? current.targetDate : request.body.targetDate;
  if (targetDate && targetDate < startDate) throw new ApiError(422, "INVALID_DATE_RANGE", "Target date must be on or after the start date.");
  if ((request.body.category ?? current.category) === "CUSTOM" && !(request.body.customCategory ?? current.customCategory)) {
    throw new ApiError(422, "CUSTOM_CATEGORY_REQUIRED", "Custom category is required.");
  }
  const metricUnit = request.body.metricUnit === undefined ? current.metricUnit : request.body.metricUnit;
  const metricTarget = request.body.metricTarget === undefined ? current.metricTarget : request.body.metricTarget;
  const metricCurrent = request.body.metricCurrent === undefined ? current.metricCurrent : request.body.metricCurrent;
  if ((metricUnit == null) !== (metricTarget == null)) {
    throw new ApiError(422, "METRIC_INCOMPLETE", "Metric unit and target must be supplied together.");
  }
  if (metricTarget == null && metricCurrent > 0) {
    throw new ApiError(422, "METRIC_TARGET_REQUIRED", "Metric progress requires a metric target.");
  }
  const scheduleChanged = request.body.frequency !== undefined
    || request.body.preferredDays !== undefined
    || request.body.preferredTime !== undefined
    || request.body.weeklyTarget !== undefined;
  const goal = await prisma.$transaction(async (transaction) => {
    const updated = await transaction.goal.update({
      where: { id: current.id },
      data: {
        ...request.body,
        completedAt: request.body.status === "COMPLETED" ? new Date() : request.body.status && request.body.status !== "COMPLETED" ? null : undefined,
      },
    });
if (scheduleChanged) {
      await transaction.routine.updateMany({
        where: { goalId: updated.id, userId: request.userId!, isActive: true },
        data: { frequency: updated.frequency, days: updated.preferredDays, preferredTime: updated.preferredTime, timesPerWeek: updated.weeklyTarget },
      });
    }
    await transaction.analyticsEvent.create({ data: { userId: request.userId!, name: request.body.status === "COMPLETED" ? "goal_completed" : "goal_edited", properties: { goalId: current.id } } });
    return updated;
  });
  const actions = await prisma.action.findMany({ where: { goalId: goal.id, userId: request.userId!, deletedAt: null }, select: { status: true, scheduledFor: true, dueDate: true } });
  response.json({ data: { ...goal, progress: calculateGoalProgress(goal, actions) } });
});

router.post("/goals/:goalId/progress", validate(schemas.goalIdParams, "params"), validate(schemas.logGoalProgressSchema), async (request, response) => {
  const current = await ownedGoal(request.userId!, request.params.goalId as string);
  if (!current.metricUnit || !current.metricTarget) {
    throw new ApiError(422, "METRIC_NOT_CONFIGURED", "Set a metric unit and target before logging progress.");
  }
  const { goal, record } = await prisma.$transaction(async (transaction) => {
    const updated = await transaction.goal.update({
      where: { id: current.id },
      data: { metricCurrent: { increment: request.body.value } },
    });
    const created = await transaction.progressRecord.create({
      data: {
        userId: request.userId!,
        goalId: current.id,
        status: "IN_PROGRESS",
        value: request.body.value,
        note: request.body.note,
      },
    });
    await transaction.analyticsEvent.create({
      data: { userId: request.userId!, name: "goal_metric_logged", properties: { goalId: current.id, value: request.body.value } },
    });
    return { goal: updated, record: created };
  });
  const actions = await prisma.action.findMany({
    where: { goalId: goal.id, userId: request.userId!, deletedAt: null },
    select: { status: true, scheduledFor: true, dueDate: true },
  });
  response.status(201).json({ data: { goal: { ...goal, progress: calculateGoalProgress(goal, actions) }, record } });
});

router.delete("/goals/:id", validate(schemas.idParams, "params"), async (request, response) => {
  const goal = await ownedGoal(request.userId!, request.params.id as string);
  const deletedAt = new Date();
  await prisma.$transaction([
    prisma.action.updateMany({ where: { goalId: goal.id, userId: request.userId!, deletedAt: null }, data: { deletedAt } }),
    prisma.milestone.updateMany({ where: { goalId: goal.id, userId: request.userId!, deletedAt: null }, data: { deletedAt } }),
    prisma.routine.updateMany({ where: { goalId: goal.id, userId: request.userId!, isActive: true }, data: { isActive: false } }),
    prisma.goal.update({ where: { id: goal.id }, data: { deletedAt, status: "ARCHIVED" } }),
  ]);
  response.status(204).send();
});

router.get("/goals/:goalId/milestones", validate(schemas.goalIdParams, "params"), async (request, response) => {
  await ownedGoal(request.userId!, request.params.goalId as string);
  const milestones = await prisma.milestone.findMany({
    where: { userId: request.userId!, goalId: request.params.goalId as string, deletedAt: null },
    include: { _count: { select: { actions: { where: { deletedAt: null } } } } },
    orderBy: { position: "asc" },
  });
  response.json({ data: milestones });
});

router.post("/goals/:goalId/milestones", validate(schemas.goalIdParams, "params"), validate(schemas.createMilestoneSchema), async (request, response) => {
  await ownedGoal(request.userId!, request.params.goalId as string);
  const position = request.body.position ?? await prisma.milestone.count({ where: { goalId: request.params.goalId as string, deletedAt: null } });
  const milestone = await prisma.$transaction(async (transaction) => {
    const created = await transaction.milestone.create({ data: { ...request.body, position, userId: request.userId!, goalId: request.params.goalId as string } });
    await transaction.analyticsEvent.create({ data: { userId: request.userId!, name: "milestone_created", properties: { milestoneId: created.id, goalId: request.params.goalId as string } } });
    return created;
  });
  response.status(201).json({ data: milestone });
});

router.patch("/milestones/:id", validate(schemas.idParams, "params"), validate(schemas.updateMilestoneSchema), async (request, response) => {
  const current = await prisma.milestone.findFirst({ where: { id: request.params.id as string, userId: request.userId!, deletedAt: null } });
  if (!current) throw new ApiError(404, "MILESTONE_NOT_FOUND", "Milestone not found.");
  const milestone = await prisma.milestone.update({
    where: { id: current.id },
    data: { ...request.body, completedAt: request.body.status === "COMPLETED" ? new Date() : request.body.status ? null : undefined },
  });
  response.json({ data: milestone });
});

router.delete("/milestones/:id", validate(schemas.idParams, "params"), async (request, response) => {
  const milestone = await prisma.milestone.findFirst({ where: { id: request.params.id as string, userId: request.userId!, deletedAt: null } });
  if (!milestone) throw new ApiError(404, "MILESTONE_NOT_FOUND", "Milestone not found.");
  await prisma.$transaction([
    prisma.action.updateMany({ where: { milestoneId: milestone.id, deletedAt: null }, data: { milestoneId: null } }),
    prisma.milestone.update({ where: { id: milestone.id }, data: { deletedAt: new Date() } }),
  ]);
  response.status(204).send();
});

router.get("/actions", validate(schemas.actionListQuery, "query"), async (request, response) => {
  const { page, limit, goalId, status, from, to } = request.query as unknown as { page: number; limit: number; goalId?: string; status?: Prisma.EnumActionStatusFilter; from?: Date; to?: Date };
  const where: Prisma.ActionWhereInput = {
    userId: request.userId!,
    deletedAt: null,
    ...(goalId ? { goalId } : {}),
    ...(status ? { status } : {}),
    ...(from || to ? { scheduledFor: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
  };
  const [actions, total] = await prisma.$transaction([
    prisma.action.findMany({ where, include: { goal: { select: { id: true, title: true, color: true, icon: true } }, milestone: { select: { id: true, title: true } } }, orderBy: [{ scheduledFor: "asc" }, { priority: "desc" }], skip: (page - 1) * limit, take: limit }),
    prisma.action.count({ where }),
  ]);
  response.json({ data: actions, meta: { page, limit, total, pages: Math.ceil(total / limit) } });
});

router.get("/actions/today", async (request, response) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: request.userId! }, select: { timezone: true } });
  const { start, end } = timezoneDayRange(user.timezone);
  const actions = await prisma.action.findMany({
    where: { userId: request.userId!, deletedAt: null, OR: [{ scheduledFor: { gte: start, lt: end } }, { dueDate: { gte: start, lt: end } }] },
    include: { goal: { select: { id: true, title: true, color: true, icon: true } }, milestone: { select: { id: true, title: true } } },
    orderBy: [{ status: "asc" }, { preferredTime: "asc" }, { priority: "desc" }],
  });
  response.json({ data: { date: start, actions } });
});

router.post("/actions", validate(schemas.createActionSchema), async (request, response) => {
  await ownedGoal(request.userId!, request.body.goalId);
  await assertMilestone(request.userId!, request.body.goalId, request.body.milestoneId);
  const now = new Date();
  const action = await prisma.$transaction(async (transaction) => {
    const created = await transaction.action.create({
      data: { ...request.body, userId: request.userId!, completedAt: request.body.status === "COMPLETED" ? now : undefined, skippedAt: request.body.status === "SKIPPED" ? now : undefined },
      include: { goal: { select: { id: true, title: true, color: true, icon: true } }, milestone: { select: { id: true, title: true } } },
    });
    if (["COMPLETED", "SKIPPED", "MISSED"].includes(created.status)) {
      await transaction.progressRecord.create({ data: { userId: request.userId!, goalId: created.goalId, actionId: created.id, status: created.status, occurredAt: now } });
    }
    await transaction.analyticsEvent.create({ data: { userId: request.userId!, name: "action_created", properties: { actionId: created.id, goalId: created.goalId } } });
    return created;
  });
  response.status(201).json({ data: action });
});

router.patch("/actions/:id", validate(schemas.idParams, "params"), validate(schemas.updateActionSchema), async (request, response) => {
  const current = await ownedAction(request.userId!, request.params.id as string);
  await assertMilestone(request.userId!, current.goalId, request.body.milestoneId);
  const { status, ...patch } = request.body;
  const action = status
    ? await transitionAction(request.userId!, current.id, status, patch)
    : await prisma.$transaction(async (transaction) => {
      const updated = await transaction.action.update({ where: { id: current.id }, data: patch, include: { goal: { select: { id: true, title: true, color: true, icon: true } }, milestone: { select: { id: true, title: true } } } });
      for (const milestoneId of new Set([current.milestoneId, updated.milestoneId])) await syncMilestoneCompletion(transaction, milestoneId);
      return updated;
    });
  response.json({ data: action });
});

router.delete("/actions/:id", validate(schemas.idParams, "params"), async (request, response) => {
  const action = await ownedAction(request.userId!, request.params.id as string);
  await prisma.$transaction(async (transaction) => {
    await transaction.action.update({ where: { id: action.id }, data: { deletedAt: new Date() } });
    await syncMilestoneCompletion(transaction, action.milestoneId);
  });
  response.status(204).send();
});

for (const [path, status] of [["complete", "COMPLETED"], ["skip", "SKIPPED"], ["start", "IN_PROGRESS"], ["reopen", "UPCOMING"], ["miss", "MISSED"]] as const) {
  router.post(`/actions/:id/${path}`, validate(schemas.idParams, "params"), async (request, response) => {
    response.json({ data: await transitionAction(request.userId!, request.params.id as string, status) });
  });
}

router.get("/routines", validate(schemas.routineListQuery, "query"), async (request, response) => {
  const { goalId, active } = request.query as unknown as { goalId?: string; active?: boolean };
  const routines = await prisma.routine.findMany({ where: { userId: request.userId!, ...(goalId ? { goalId } : {}), ...(active === undefined ? {} : { isActive: active }) }, include: { goal: { select: { id: true, title: true, color: true, icon: true } } }, orderBy: { createdAt: "desc" } });
  response.json({ data: routines });
});

router.post("/routines", validate(schemas.createRoutineSchema), async (request, response) => {
  await ownedGoal(request.userId!, request.body.goalId);
  const routine = await prisma.routine.create({ data: { ...request.body, userId: request.userId! } });
  response.status(201).json({ data: routine });
});

router.patch("/routines/:id", validate(schemas.idParams, "params"), validate(schemas.updateRoutineSchema), async (request, response) => {
  const current = await prisma.routine.findFirst({ where: { id: request.params.id as string, userId: request.userId! } });
  if (!current) throw new ApiError(404, "ROUTINE_NOT_FOUND", "Routine not found.");
  response.json({ data: await prisma.routine.update({ where: { id: current.id }, data: request.body }) });
});

router.delete("/routines/:id", validate(schemas.idParams, "params"), async (request, response) => {
  const current = await prisma.routine.findFirst({ where: { id: request.params.id as string, userId: request.userId! } });
  if (!current) throw new ApiError(404, "ROUTINE_NOT_FOUND", "Routine not found.");
  await prisma.routine.delete({ where: { id: current.id } });
  response.status(204).send();
});

async function periodSummary(userId: string, start: Date, end: Date) {
  const [actions, records] = await Promise.all([
    prisma.action.findMany({
      where: { userId, deletedAt: null, scheduledFor: { gte: start, lt: end } },
      include: { goal: { select: { id: true, title: true, category: true } } },
    }),
    prisma.progressRecord.findMany({
      where: { userId, occurredAt: { gte: start, lt: end }, status: { in: ["COMPLETED", "MISSED", "SKIPPED"] } },
      include: { goal: { select: { id: true, title: true, category: true } } },
    }),
  ]);
  const completed = records.filter((record) => record.status === "COMPLETED");
  const missed = records.filter((record) => record.status === "MISSED");
  const skipped = records.filter((record) => record.status === "SKIPPED");
  const byGoal = new Map<string, { id: string; title: string; category: string; planned: number; completed: number }>();
  for (const action of actions) {
    const value = byGoal.get(action.goalId) ?? { ...action.goal, planned: 0, completed: 0 };
    value.planned++;
    byGoal.set(action.goalId, value);
  }
  for (const record of completed) {
    const value = byGoal.get(record.goalId) ?? { ...record.goal, planned: 0, completed: 0 };
    value.completed++;
    byGoal.set(record.goalId, value);
  }
  const plannedIds = new Set(actions.map((action) => action.id));
  const completedPlanned = new Set(completed.map((record) => record.actionId).filter((id) => id && plannedIds.has(id))).size;
  const areas = [...byGoal.values()].filter((item) => item.planned > 0).sort((a, b) => (b.completed / b.planned) - (a.completed / a.planned));
  return {
    periodStart: start,
    periodEnd: end,
    planned: actions.length,
    completed: completed.length,
    missed: missed.length,
    skipped: skipped.length,
    completionRate: actions.length ? Math.round((completedPlanned / actions.length) * 100) : 0,
    goalsWorkedOn: [...byGoal.values()].filter((item) => item.completed > 0),
    strongestArea: areas[0] ?? null,
    needsAttention: areas.length > 1 ? areas.at(-1) : null,
  };
}

router.get("/progress/overview", async (request, response) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: request.userId! }, select: { timezone: true, preferences: { select: { weekStartsOn: true } } } });
  const range = timezoneWeekRange(user.timezone, new Date(), user.preferences?.weekStartsOn ?? 1);
  const [goals, weekly] = await Promise.all([
    prisma.goal.findMany({ where: { userId: request.userId!, deletedAt: null, status: "ACTIVE" }, include: { actions: { where: { deletedAt: null }, select: { status: true, scheduledFor: true, dueDate: true } } }, orderBy: { priority: "desc" } }),
    periodSummary(request.userId!, range.start, range.end),
  ]);
  response.json({ data: { activeGoals: goals.map(({ actions, ...goal }) => ({ ...goal, progress: calculateGoalProgress(goal, actions) })), weekly } });
});

router.get("/progress/goals/:goalId", validate(schemas.goalIdParams, "params"), async (request, response) => {
  const goal = await ownedGoal(request.userId!, request.params.goalId as string);
  const [actions, history] = await Promise.all([
    prisma.action.findMany({ where: { userId: request.userId!, goalId: goal.id, deletedAt: null } }),
    prisma.progressRecord.findMany({ where: { userId: request.userId!, goalId: goal.id }, include: { action: { select: { id: true, title: true } } }, orderBy: { occurredAt: "desc" }, take: 100 }),
  ]);
  response.json({ data: { goalId: goal.id, ...calculateGoalProgress(goal, actions), history } });
});

router.get("/progress/history", validate(schemas.progressHistoryQuery, "query"), async (request, response) => {
  const { from, to } = request.query as unknown as { from?: Date; to?: Date };
  const history = await prisma.progressRecord.findMany({
    where: { userId: request.userId!, ...(from || to ? { occurredAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}) },
    include: { action: { select: { id: true, title: true } }, goal: { select: { id: true, title: true, category: true } } },
    orderBy: { occurredAt: "desc" },
    take: 1_000,
  });
  response.json({ data: { history } });
});

router.get("/progress/weekly", async (request, response) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: request.userId! }, select: { timezone: true, preferences: { select: { weekStartsOn: true } } } });
  const { start, end } = timezoneWeekRange(user.timezone, new Date(), user.preferences?.weekStartsOn ?? 1);
  response.json({ data: await periodSummary(request.userId!, start, end) });
});

router.get("/progress/monthly", async (request, response) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: request.userId! }, select: { timezone: true } });
  const { start, end } = timezoneMonthRange(user.timezone);
  response.json({ data: await periodSummary(request.userId!, start, end) });
});

router.get("/dashboard", async (request, response) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: request.userId! }, select: { timezone: true } });
  const { start, end } = timezoneDayRange(user.timezone);
  const upcomingLimit = new Date(end.getTime() + 7 * 86_400_000);
  const [today, goals, milestones, recent] = await Promise.all([
    prisma.action.findMany({ where: { userId: request.userId!, deletedAt: null, OR: [{ scheduledFor: { gte: start, lt: end } }, { dueDate: { gte: start, lt: end } }] }, include: { goal: { select: { id: true, title: true, color: true, icon: true } } }, orderBy: [{ status: "asc" }, { preferredTime: "asc" }] }),
    prisma.goal.findMany({ where: { userId: request.userId!, deletedAt: null, status: "ACTIVE" }, include: { actions: { where: { deletedAt: null }, select: { status: true, scheduledFor: true, dueDate: true } } }, orderBy: { priority: "desc" }, take: 5 }),
    prisma.milestone.findMany({ where: { userId: request.userId!, deletedAt: null, status: { not: "COMPLETED" }, targetDate: { gte: start, lt: upcomingLimit } }, include: { goal: { select: { id: true, title: true, color: true } } }, orderBy: { targetDate: "asc" }, take: 5 }),
    prisma.action.findMany({ where: { userId: request.userId!, deletedAt: null, status: "COMPLETED", completedAt: { not: null } }, include: { goal: { select: { id: true, title: true, color: true } } }, orderBy: { completedAt: "desc" }, take: 5 }),
  ]);
  response.json({ data: { date: start, today, activeGoals: goals.map(({ actions, ...goal }) => ({ ...goal, progress: calculateGoalProgress(goal, actions) })), upcomingMilestones: milestones, recentlyCompleted: recent } });
});

router.get("/schedule", validate(schemas.scheduleQuery, "query"), async (request, response) => {
  const { from, to } = request.query as unknown as { from: Date; to: Date };
  const [actions, milestones] = await Promise.all([
    prisma.action.findMany({ where: { userId: request.userId!, deletedAt: null, OR: [{ scheduledFor: { gte: from, lte: to } }, { dueDate: { gte: from, lte: to } }] }, include: { goal: { select: { id: true, title: true, color: true, icon: true } } }, orderBy: { scheduledFor: "asc" } }),
    prisma.milestone.findMany({ where: { userId: request.userId!, deletedAt: null, targetDate: { gte: from, lte: to } }, include: { goal: { select: { id: true, title: true, color: true, icon: true } } }, orderBy: { targetDate: "asc" } }),
  ]);
  response.json({ data: { from, to, actions, milestones } });
});

router.get("/reflections", validate(schemas.reflectionListQuery, "query"), async (request, response) => {
  const { page, limit } = request.query as unknown as { page: number; limit: number };
  const where = { userId: request.userId! };
  const [items, total] = await prisma.$transaction([
    prisma.reflection.findMany({ where, orderBy: { periodStart: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.reflection.count({ where }),
  ]);
  response.json({ data: items, meta: { page, limit, total, pages: Math.ceil(total / limit) } });
});

router.post("/reflections", validate(schemas.createReflectionSchema), async (request, response) => {
  const reflection = await prisma.$transaction(async (transaction) => {
    const created = await transaction.reflection.create({ data: { ...request.body, userId: request.userId! } });
    await transaction.analyticsEvent.create({ data: { userId: request.userId!, name: "reflection_submitted", properties: { reflectionId: created.id } } });
    return created;
  });
  response.status(201).json({ data: reflection });
});

router.patch("/reflections/:id", validate(schemas.idParams, "params"), validate(schemas.updateReflectionSchema), async (request, response) => {
  const reflection = await prisma.reflection.findFirst({ where: { id: request.params.id as string, userId: request.userId! } });
  if (!reflection) throw new ApiError(404, "REFLECTION_NOT_FOUND", "Reflection not found.");
  response.json({ data: await prisma.reflection.update({ where: { id: reflection.id }, data: request.body }) });
});

router.get("/notifications", validate(schemas.notificationListQuery, "query"), async (request, response) => {
  const { page, limit, unreadOnly } = request.query as unknown as { page: number; limit: number; unreadOnly: boolean };
  const available: Prisma.NotificationWhereInput = { OR: [{ scheduledAt: null }, { scheduledAt: { lte: new Date() } }] };
  const where: Prisma.NotificationWhereInput = { userId: request.userId!, ...available, ...(unreadOnly ? { readAt: null } : {}) };
  const [items, total, unread] = await prisma.$transaction([
    prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId: request.userId!, readAt: null, ...available } }),
  ]);
  response.json({ data: items, meta: { page, limit, total, pages: Math.ceil(total / limit), unread } });
});

router.get("/notifications/preferences", async (request, response) => {
  response.json({ data: await prisma.notificationPreference.findUnique({ where: { userId: request.userId! } }) });
});

router.patch("/notifications/preferences", validate(schemas.notificationPreferenceSchema), async (request, response) => {
  const preference = await prisma.notificationPreference.upsert({ where: { userId: request.userId! }, create: { userId: request.userId!, ...request.body }, update: request.body });
  response.json({ data: preference });
});

router.post("/notifications/devices", validate(schemas.pushDeviceSchema), async (request, response) => {
  const device = await prisma.pushDevice.upsert({
    where: { token: request.body.token },
    create: { userId: request.userId!, ...request.body },
    update: { userId: request.userId!, platform: request.body.platform, deviceName: request.body.deviceName, enabled: true, lastSeenAt: new Date() },
  });
  response.status(201).json({ data: device });
});

router.post("/notifications/devices/unregister", validate(schemas.pushTokenSchema), async (request, response) => {
  await prisma.pushDevice.updateMany({ where: { userId: request.userId!, token: request.body.token }, data: { enabled: false } });
  response.status(204).send();
});

router.patch("/notifications/:id/read", validate(schemas.idParams, "params"), async (request, response) => {
  const notification = await prisma.notification.findFirst({ where: { id: request.params.id as string, userId: request.userId!, OR: [{ scheduledAt: null }, { scheduledAt: { lte: new Date() } }] } });
  if (!notification) throw new ApiError(404, "NOTIFICATION_NOT_FOUND", "Notification not found.");
  response.json({ data: await prisma.notification.update({ where: { id: notification.id }, data: { readAt: new Date() } }) });
});

router.post("/notifications/read-all", async (request, response) => {
  const result = await prisma.notification.updateMany({ where: { userId: request.userId!, readAt: null, OR: [{ scheduledAt: null }, { scheduledAt: { lte: new Date() } }] }, data: { readAt: new Date() } });
  response.json({ data: { updated: result.count } });
});

export default router;
