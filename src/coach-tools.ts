import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { ownedAction, syncMilestoneCompletion, transitionAction } from "./action-service.js";
import { prisma } from "./db.js";
import { ApiError } from "./errors.js";
import { formatRelativeTimezoneDateTime, formatTimezoneDateTime, timezoneDayRange, timezoneWeekRange } from "./goal-progress.js";
import { generateRoutineActions } from "./maintenance.js";
import { queueGoalCreatedNotification } from "./push.js";

const actionStatus = z.enum(["UPCOMING", "IN_PROGRESS", "COMPLETED", "MISSED", "SKIPPED"]);
const day = z.enum(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const id = z.string().cuid();

export const coachTools = [
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "Show the user's tasks. Use this whenever they ask what is due, upcoming, completed, or on their task list.",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["TODAY", "TOMORROW", "THIS_WEEK", "ALL"], description: "Date range to show. Use TOMORROW for 'tomorrow' or 'kal' questions." },
          status: { type: "string", enum: ["OPEN", "UPCOMING", "IN_PROGRESS", "COMPLETED", "MISSED", "SKIPPED", "ALL"] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_goals",
      description: "Show the user's active, paused, or completed goals.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_profile",
      description: "Read the user's account profile and planning preferences. Use this for questions about their saved name, objective, preferred days or time, working frequency, constraints, progress style, or timezone.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "create_goal",
      description: "Create a goal, its routine, and a progressive AI-generated task plan. Omitted schedule fields use the user's saved profile schedule.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: ["string", "null"] },
          whyItMatters: { type: ["string", "null"] },
          category: { type: "string", enum: ["HEALTH", "LEARNING", "CAREER", "PERSONAL", "FINANCE", "RELATIONSHIPS", "PRODUCTIVITY", "CUSTOM"] },
          customCategory: { type: ["string", "null"] },
          priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
          targetDate: { type: ["string", "null"], description: "ISO-8601 date-time, or null for an ongoing goal." },
          frequency: { type: "string", enum: ["ONCE", "DAILY", "WEEKLY", "MONTHLY", "CUSTOM"] },
          preferredDays: { type: "array", items: { type: "string", enum: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] }, maxItems: 7 },
          preferredTime: { type: ["string", "null"], description: "24-hour HH:mm, or null." },
          weeklyTarget: { type: "integer", minimum: 1, maximum: 21 },
          durationMinutes: { type: "integer", minimum: 5, maximum: 480 },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_task",
      description: "Create a task under one of the user's existing goals.",
      parameters: {
        type: "object",
        properties: {
          goalId: { type: "string" },
          title: { type: "string" },
          scheduledFor: { type: "string", description: "ISO-8601 date-time with timezone." },
          preferredTime: { type: "string", description: "24-hour HH:mm." },
          estimatedMinutes: { type: "integer", minimum: 5, maximum: 480 },
        },
        required: ["goalId", "title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description: "Complete, reopen, start, skip, miss, rename, reschedule, or change the duration of a task. A request to skip must use status SKIPPED; skipping is never deletion.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          status: { type: "string", enum: ["UPCOMING", "IN_PROGRESS", "COMPLETED", "MISSED", "SKIPPED"] },
          title: { type: "string" },
          scheduledFor: { type: ["string", "null"], description: "ISO-8601 date-time with timezone, or null." },
          preferredTime: { type: ["string", "null"], description: "24-hour HH:mm, or null." },
          estimatedMinutes: { type: "integer", minimum: 5, maximum: 480 },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description: "Permanently delete a task only when the user explicitly asks to delete it. Never use this for skip. First call with confirmedByUser=false so Tara asks for confirmation. Use true only after the user's latest message confirms deletion.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          confirmedByUser: { type: "boolean" },
        },
        required: ["taskId", "confirmedByUser"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_profile",
      description: "Update the user's name, main objective, schedule, constraints, or progress-detail preference.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          mainObjective: { type: ["string", "null"] },
          preferredDays: { type: "array", items: { type: "string", enum: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] }, maxItems: 7 },
          preferredTime: { type: ["string", "null"], description: "24-hour HH:mm, or null." },
          workingFrequency: { type: "integer", minimum: 1, maximum: 21 },
          personalConstraints: { type: ["string", "null"] },
          progressStyle: { type: "string", enum: ["GENTLE", "BALANCED", "DETAILED"] },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_goal",
      description: "Rename, describe, pause, resume, complete, or change the target date of a goal.",
      parameters: {
        type: "object",
        properties: {
          goalId: { type: "string" },
          title: { type: "string" },
          description: { type: ["string", "null"] },
          whyItMatters: { type: ["string", "null"] },
          targetDate: { type: ["string", "null"], description: "ISO-8601 date-time, or null." },
          status: { type: "string", enum: ["ACTIVE", "PAUSED", "COMPLETED"] },
        },
        required: ["goalId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_goal",
      description: "Delete a goal and its tasks. First call with confirmedByUser=false so Tara asks for confirmation. Use true only after the user's latest message confirms deletion.",
      parameters: {
        type: "object",
        properties: {
          goalId: { type: "string" },
          confirmedByUser: { type: "boolean" },
        },
        required: ["goalId", "confirmedByUser"],
        additionalProperties: false,
      },
    },
  },
] as const;

type ToolResult = { content: unknown; changed: boolean };

function argumentsOf(raw: string) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new ApiError(422, "INVALID_TOOL_ARGUMENTS", "Tara could not understand that change.");
  }
}

function deletionConfirmed(message: string) {
  const value = message.trim().toLocaleLowerCase();
  return /^(yes|yep|confirm|confirmed|do it|go ahead|delete it|remove it|yes[, ]+delete.*|haan|han|ha|हाँ|हां|जी हाँ|kar do|delete kar do|कर दो)[.! ]*$/iu.test(value);
}

function mutationRequested(message: string) {
  return /\b(create|add|set|use|make|change|update|rename|move|reschedule|schedule|mark|complete|finish|finished|done|reopen|start|begin|skip|miss|pause|resume|delete|remove|save)\b|\b(bana|banao|jod|badal|hata|shuru|rok|kar do|kar diya)\b|(?:बना|जोड़|बदल|हटा|शुरू|रोक|पूरा|मिटा)/iu.test(message);
}

async function ownedGoal(userId: string, goalId: string) {
  const goal = await prisma.goal.findFirst({ where: { id: goalId, userId, deletedAt: null } });
  if (!goal) throw new ApiError(404, "GOAL_NOT_FOUND", "Goal not found.");
  return goal;
}

const listTasksSchema = z.object({
  scope: z.enum(["TODAY", "TOMORROW", "THIS_WEEK", "ALL"]).default("ALL"),
  status: z.enum(["OPEN", "UPCOMING", "IN_PROGRESS", "COMPLETED", "MISSED", "SKIPPED", "ALL"]).default("OPEN"),
}).strict();

const createGoalSchema = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(2_000).nullable().optional(),
  whyItMatters: z.string().trim().max(1_000).nullable().optional(),
  category: z.enum(["HEALTH", "LEARNING", "CAREER", "PERSONAL", "FINANCE", "RELATIONSHIPS", "PRODUCTIVITY", "CUSTOM"]).default("PERSONAL"),
  customCategory: z.string().trim().max(60).nullable().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
  targetDate: z.union([z.null(), z.coerce.date()]).optional(),
  frequency: z.enum(["ONCE", "DAILY", "WEEKLY", "MONTHLY", "CUSTOM"]).default("WEEKLY"),
  preferredDays: z.array(day).max(7).optional(),
  preferredTime: time.nullable().optional(),
  weeklyTarget: z.number().int().min(1).max(21).optional(),
  durationMinutes: z.number().int().min(5).max(480).default(30),
}).strict().refine(
  (value) => value.category !== "CUSTOM" || Boolean(value.customCategory),
  { message: "A custom category name is required.", path: ["customCategory"] },
);

const createTaskSchema = z.object({
  goalId: id,
  title: z.string().trim().min(1).max(160),
  scheduledFor: z.coerce.date().optional(),
  preferredTime: time.optional(),
  estimatedMinutes: z.number().int().min(5).max(480).default(30),
}).strict();

const updateTaskSchema = z.object({
  taskId: id,
  status: actionStatus.optional(),
  title: z.string().trim().min(1).max(160).optional(),
  scheduledFor: z.union([z.null(), z.coerce.date()]).optional(),
  preferredTime: time.nullable().optional(),
  estimatedMinutes: z.number().int().min(5).max(480).optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== "taskId"), "No task change was supplied.");

const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  mainObjective: z.string().trim().max(500).nullable().optional(),
  preferredDays: z.array(day).max(7).optional(),
  preferredTime: time.nullable().optional(),
  workingFrequency: z.number().int().min(1).max(21).optional(),
  personalConstraints: z.string().trim().max(1_000).nullable().optional(),
  progressStyle: z.enum(["GENTLE", "BALANCED", "DETAILED"]).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "No profile change was supplied.");

const updateGoalSchema = z.object({
  goalId: id,
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
  whyItMatters: z.string().trim().max(1_000).nullable().optional(),
  targetDate: z.union([z.null(), z.coerce.date()]).optional(),
  status: z.enum(["ACTIVE", "PAUSED", "COMPLETED"]).optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== "goalId"), "No goal change was supplied.");

export async function executeCoachTool(
  userId: string,
  name: string,
  rawArguments: string,
  latestMessage: string,
  timeZone = "UTC",
): Promise<ToolResult> {
  const raw = argumentsOf(rawArguments);
  if (["create_goal", "create_task", "update_task", "delete_task", "update_profile", "update_goal", "delete_goal"].includes(name)
    && !mutationRequested(latestMessage)
    && !(name.startsWith("delete_") && deletionConfirmed(latestMessage))) {
    return { content: { error: "Ask the user to explicitly request the change before updating their data." }, changed: false };
  }
  if (name === "list_tasks") {
    const input = listTasksSchema.parse(raw);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { timezone: true, preferences: { select: { weekStartsOn: true } } } });
    const todayRange = timezoneDayRange(user.timezone);
    const range = input.scope === "TODAY"
      ? todayRange
      : input.scope === "TOMORROW"
        ? timezoneDayRange(user.timezone, todayRange.end)
      : input.scope === "THIS_WEEK"
        ? timezoneWeekRange(user.timezone, new Date(), user.preferences?.weekStartsOn ?? 1)
        : null;
    const status: Prisma.ActionWhereInput["status"] = input.status === "OPEN"
      ? { in: ["UPCOMING", "IN_PROGRESS"] }
      : input.status === "ALL"
        ? undefined
        : input.status;
    const tasks = await prisma.action.findMany({
      where: {
        userId,
        deletedAt: null,
        ...(status ? { status } : {}),
        ...(range ? { scheduledFor: { gte: range.start, lt: range.end } } : {}),
      },
      select: { id: true, title: true, status: true, scheduledFor: true, preferredTime: true, estimatedMinutes: true, goal: { select: { id: true, title: true } } },
      orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }],
      take: 11,
    });
    return {
      content: {
        tasks: tasks.slice(0, 10).map((task) => ({
          ...task,
          localScheduledFor: task.scheduledFor ? formatTimezoneDateTime(user.timezone, task.scheduledFor) : null,
          scheduleLabel: task.scheduledFor ? formatRelativeTimezoneDateTime(user.timezone, task.scheduledFor) : null,
        })),
        hasMore: tasks.length > 10,
      },
      changed: false,
    };
  }

  if (name === "list_goals") {
    z.object({}).strict().parse(raw);
    const goals = await prisma.goal.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, title: true, status: true, targetDate: true, weeklyTarget: true, preferredDays: true, preferredTime: true, _count: { select: { actions: { where: { deletedAt: null } } } } },
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      take: 20,
    });
    return { content: { goals }, changed: false };
  }

  if (name === "get_profile") {
    z.object({}).strict().parse(raw);
    const profile = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { name: true, mainObjective: true, timezone: true, preferences: true },
    });
    return { content: { profile }, changed: false };
  }

  if (name === "create_goal") {
    const input = createGoalSchema.parse(raw);
    const now = new Date();
    if (input.targetDate && input.targetDate < now) {
      throw new ApiError(422, "INVALID_DATE_RANGE", "Target date must be in the future.");
    }
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { preferences: { select: { preferredDays: true, preferredTime: true, workingFrequency: true } } },
    });
    const weeklyTarget = input.weeklyTarget ?? user.preferences?.workingFrequency ?? 3;
    const preferredDays = input.preferredDays ?? user.preferences?.preferredDays ?? [];
    const preferredTime = input.preferredTime === undefined
      ? user.preferences?.preferredTime ?? null
      : input.preferredTime;
    const goal = await prisma.$transaction(async (transaction) => {
      const created = await transaction.goal.create({
        data: {
          userId,
          title: input.title,
          description: input.description,
          whyItMatters: input.whyItMatters,
          category: input.category,
          customCategory: input.customCategory,
          priority: input.priority,
          startDate: now,
          targetDate: input.targetDate,
          frequency: input.frequency,
          preferredDays,
          preferredTime,
          weeklyTarget,
        },
      });
      await transaction.routine.create({
        data: {
          userId,
          goalId: created.id,
          name: `${created.title} plan`,
          frequency: input.frequency,
          days: preferredDays,
          preferredTime,
          durationMinutes: input.durationMinutes,
          timesPerWeek: weeklyTarget,
        },
      });
      await transaction.analyticsEvent.create({
        data: { userId, name: "goal_created", properties: { goalId: created.id, category: created.category, source: "tara" } },
      });
      await queueGoalCreatedNotification(transaction, userId, created);
      return created;
    });
    const generatedTaskCount = await generateRoutineActions(now, 21, goal.id);
    return {
      content: {
        goal: { id: goal.id, title: goal.title, status: goal.status, targetDate: goal.targetDate, preferredDays, preferredTime, weeklyTarget },
        generatedTaskCount,
      },
      changed: true,
    };
  }

  if (name === "create_task") {
    const input = createTaskSchema.parse(raw);
    await ownedGoal(userId, input.goalId);
    const localScheduledFor = input.scheduledFor ? formatTimezoneDateTime(timeZone, input.scheduledFor) : null;
    const task = await prisma.action.create({
      data: {
        userId,
        goalId: input.goalId,
        title: input.title,
        scheduledFor: input.scheduledFor,
        dueDate: input.scheduledFor,
        preferredTime: input.preferredTime ?? localScheduledFor?.slice(-5),
        estimatedMinutes: input.estimatedMinutes,
      },
      select: { id: true, title: true, status: true, scheduledFor: true, preferredTime: true, estimatedMinutes: true },
    });
    return {
      content: {
        task: {
          ...task,
          localScheduledFor,
          scheduleLabel: task.scheduledFor ? formatRelativeTimezoneDateTime(timeZone, task.scheduledFor) : null,
        },
      },
      changed: true,
    };
  }

  if (name === "update_task") {
    const { taskId, status, ...fields } = updateTaskSchema.parse(raw);
    await ownedAction(userId, taskId);
    const localScheduledFor = fields.scheduledFor instanceof Date ? formatTimezoneDateTime(timeZone, fields.scheduledFor) : null;
    const patch: Prisma.ActionUpdateInput = {
      ...fields,
      dueDate: fields.scheduledFor,
      preferredTime: fields.preferredTime === undefined ? localScheduledFor?.slice(-5) : fields.preferredTime,
    };
    const task = status
      ? await transitionAction(userId, taskId, status, patch)
      : await prisma.action.update({ where: { id: taskId }, data: patch });
    return {
      content: {
        task: {
          id: task.id,
          title: task.title,
          status: task.status,
          scheduledFor: task.scheduledFor,
          preferredTime: task.preferredTime,
          estimatedMinutes: task.estimatedMinutes,
          localScheduledFor: task.scheduledFor ? formatTimezoneDateTime(timeZone, task.scheduledFor) : null,
          scheduleLabel: task.scheduledFor ? formatRelativeTimezoneDateTime(timeZone, task.scheduledFor) : null,
        },
      },
      changed: true,
    };
  }

  if (name === "delete_task") {
    const input = z.object({ taskId: id, confirmedByUser: z.boolean() }).strict().parse(raw);
    const task = await ownedAction(userId, input.taskId);
    if (!input.confirmedByUser || !deletionConfirmed(latestMessage)) {
      return { content: { confirmationRequired: true, item: task.title, instruction: "Ask the user to confirm deleting this task." }, changed: false };
    }
    await prisma.$transaction(async (transaction) => {
      await transaction.action.update({ where: { id: task.id }, data: { deletedAt: new Date() } });
      await syncMilestoneCompletion(transaction, task.milestoneId);
    });
    return { content: { deleted: true, item: task.title }, changed: true };
  }

  if (name === "update_profile") {
    const input = updateProfileSchema.parse(raw);
    const { name: userName, mainObjective, ...preferenceInput } = input;
    const preferences = {
      ...preferenceInput,
      ...(preferenceInput.preferredDays?.length && preferenceInput.workingFrequency === undefined
        ? { workingFrequency: preferenceInput.preferredDays.length }
        : {}),
    };
    await prisma.$transaction(async (transaction) => {
      if (userName !== undefined || mainObjective !== undefined) {
        await transaction.user.update({ where: { id: userId }, data: { name: userName, mainObjective } });
      }
      if (Object.keys(preferences).length) {
        await transaction.userPreference.upsert({
          where: { userId },
          create: { userId, preferredDays: preferences.preferredDays ?? [], ...preferences },
          update: preferences,
        });
      }
    });
    const profile = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { name: true, mainObjective: true, timezone: true, preferences: true },
    });
    return { content: { profile }, changed: true };
  }

  if (name === "update_goal") {
    const { goalId, status, ...fields } = updateGoalSchema.parse(raw);
    const current = await ownedGoal(userId, goalId);
    if (fields.targetDate && fields.targetDate < current.startDate) {
      throw new ApiError(422, "INVALID_DATE_RANGE", "Target date must be on or after the start date.");
    }
    const goal = await prisma.goal.update({
      where: { id: goalId },
      data: {
        ...fields,
        status,
        completedAt: status === "COMPLETED" ? new Date() : status ? null : undefined,
      },
      select: { id: true, title: true, status: true, targetDate: true },
    });
    return { content: { goal }, changed: true };
  }

  if (name === "delete_goal") {
    const input = z.object({ goalId: id, confirmedByUser: z.boolean() }).strict().parse(raw);
    const goal = await ownedGoal(userId, input.goalId);
    if (!input.confirmedByUser || !deletionConfirmed(latestMessage)) {
      return { content: { confirmationRequired: true, item: goal.title, instruction: "Ask the user to confirm deleting this goal and its tasks." }, changed: false };
    }
    const deletedAt = new Date();
    await prisma.$transaction([
      prisma.action.updateMany({ where: { goalId: goal.id, userId, deletedAt: null }, data: { deletedAt } }),
      prisma.milestone.updateMany({ where: { goalId: goal.id, userId, deletedAt: null }, data: { deletedAt } }),
      prisma.routine.updateMany({ where: { goalId: goal.id, userId, isActive: true }, data: { isActive: false } }),
      prisma.goal.update({ where: { id: goal.id }, data: { deletedAt, status: "ARCHIVED" } }),
    ]);
    return { content: { deleted: true, item: goal.title }, changed: true };
  }

  throw new ApiError(422, "UNKNOWN_TOOL", "Tara tried to use an unsupported action.");
}
