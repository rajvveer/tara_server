import type { Frequency } from "@prisma/client";
import { prisma } from "./db.js";
import { generateGoalActionTitles } from "./goal-plan.js";
import { timezoneDateParts, timezoneDayRange, zonedDateTime } from "./goal-progress.js";
import { dispatchDueNotifications } from "./push.js";

type CalendarDate = { year: number; month: number; day: number };
type RoutineRule = { frequency: Frequency; days: string[]; timesPerWeek: number | null; createdAt: Date };

const dayNames = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
const addDays = (date: CalendarDate, amount: number): CalendarDate => {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + amount));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
};
const compareDate = (a: CalendarDate, b: CalendarDate) => Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day);
const dateKey = (date: CalendarDate) => `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;

export function outsideQuietHours(timeZone: string, value: Date, startValue: string | null, endValue: string | null) {
  if (!startValue || !endValue) return value;
  const [startHour, startMinute] = startValue.split(":").map(Number);
  const [endHour, endMinute] = endValue.split(":").map(Number);
  if ([startHour, startMinute, endHour, endMinute].some((part) => !Number.isFinite(part))) return value;
  const date = timezoneDateParts(timeZone, value);
  const localMidnight = zonedDateTime(timeZone, date.year, date.month, date.day, 0);
  const minute = Math.round((value.getTime() - localMidnight.getTime()) / 60_000);
  const start = startHour! * 60 + startMinute!;
  const end = endHour! * 60 + endMinute!;
  const wraps = start >= end;
  const quiet = wraps ? minute >= start || minute < end : minute >= start && minute < end;
  if (!quiet) return value;
  const wakeDate = wraps && minute >= start ? addDays(date, 1) : date;
  return zonedDateTime(timeZone, wakeDate.year, wakeDate.month, wakeDate.day, endHour, endMinute);
}

export function shouldScheduleRoutine(rule: RoutineRule, date: CalendarDate, timeZone: string) {
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  if (rule.frequency === "DAILY") return !rule.days.length || rule.days.includes(dayNames[weekday]!);
  if (rule.frequency === "WEEKLY" || rule.frequency === "CUSTOM") {
    if (rule.days.length) return rule.days.includes(dayNames[weekday]!);
    return weekday > 0 && weekday <= Math.min(rule.timesPerWeek ?? 1, 7);
  }
  if (rule.frequency === "MONTHLY") {
    const created = timezoneDateParts(timeZone, rule.createdAt);
    const lastDay = new Date(Date.UTC(date.year, date.month, 0)).getUTCDate();
    return date.day === Math.min(created.day, lastDay);
  }
  return true;
}

export function remainingTaskCount(timeZone: string, now: Date, dueDates: Array<Date | null>) {
  const today = timezoneDateParts(timeZone, now);
  if (now < zonedDateTime(timeZone, today.year, today.month, today.day, 20)) return 0;
  const { start, end } = timezoneDayRange(timeZone, now);
  return dueDates.filter((due) => due && due >= start && due < end).length;
}

function parseTime(value: string | null) {
  const match = /^(\d{2}):(\d{2})$/.exec(value ?? "");
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : { hour: 9, minute: 0 };
}

export async function generateRoutineActions(now = new Date(), lookaheadDays = 21, goalId?: string) {
  const routines = await prisma.routine.findMany({
    where: { isActive: true, goal: { id: goalId, deletedAt: null, status: "ACTIVE" } },
    include: {
      user: { select: { timezone: true, preferences: { select: { personalConstraints: true } } } },
      actions: { where: { deletedAt: null }, select: { id: true, title: true, scheduledFor: true, dueDate: true } },
      goal: { include: { milestones: { where: { deletedAt: null }, orderBy: { position: "asc" } } } },
    },
  });
  let created = 0;
  for (const routine of routines) {
    const today = timezoneDateParts(routine.user.timezone, now);
    const horizon = addDays(today, lookaheadDays);
    const latest = routine.actions
      .map((action) => action.scheduledFor ?? action.dueDate)
      .filter((value): value is Date => value !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    let date = latest ? addDays(timezoneDateParts(routine.user.timezone, latest), 1) : today;
    if (compareDate(date, today) < 0) date = today;
    const time = parseTime(routine.preferredTime ?? routine.goal.preferredTime);
    const slots: Array<{ existingId?: string; date: CalendarDate; scheduledFor: Date }> = routine.actions
      .filter((action) => action.title.trim().toLocaleLowerCase() === `continue ${routine.goal.title}`.toLocaleLowerCase())
      .flatMap((action) => {
        const scheduledFor = action.scheduledFor ?? action.dueDate;
        return scheduledFor ? [{ existingId: action.id, date: timezoneDateParts(routine.user.timezone, scheduledFor), scheduledFor }] : [];
      });
    while (compareDate(date, horizon) <= 0) {
      if (routine.frequency === "ONCE" && routine.actions.length + slots.filter((slot) => !slot.existingId).length > 0) break;
      if (shouldScheduleRoutine(routine, date, routine.user.timezone)) {
        const scheduledFor = zonedDateTime(routine.user.timezone, date.year, date.month, date.day, time.hour, time.minute);
        const afterStart = scheduledFor >= routine.goal.startDate;
        const beforeTarget = !routine.goal.targetDate || scheduledFor <= new Date(routine.goal.targetDate.getTime() + 86_399_999);
        if (afterStart && beforeTarget) slots.push({ date, scheduledFor });
      }
      date = addDays(date, 1);
    }
    if (!slots.length) continue;
    slots.sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());
    const titles = await generateGoalActionTitles({
      title: routine.goal.title,
      description: routine.goal.description,
      whyItMatters: routine.goal.whyItMatters,
      category: routine.goal.category,
      customCategory: routine.goal.customCategory,
      frequency: routine.frequency,
      weeklyTarget: routine.timesPerWeek ?? routine.goal.weeklyTarget,
      preferredDays: routine.days.length ? routine.days : routine.goal.preferredDays,
      preferredTime: routine.preferredTime ?? routine.goal.preferredTime,
      durationMinutes: routine.durationMinutes,
      targetDate: routine.goal.targetDate?.toISOString() ?? null,
      constraints: routine.user.preferences?.personalConstraints ?? null,
      milestones: routine.goal.milestones.map((milestone) => ({ title: milestone.title, targetDate: milestone.targetDate?.toISOString() ?? null })),
      existingTitles: routine.actions
        .filter((action) => !slots.some((slot) => slot.existingId === action.id))
        .map((action) => action.title),
      dates: slots.map((slot) => dateKey(slot.date)),
    });
    const milestoneFor = (slot: typeof slots[number], index: number) => {
      const dated = routine.goal.milestones.find((milestone) => milestone.targetDate && milestone.targetDate >= slot.scheduledFor);
      return dated?.id ?? routine.goal.milestones[Math.min(Math.floor(index * routine.goal.milestones.length / slots.length), routine.goal.milestones.length - 1)]?.id;
    };
    const updates = slots.flatMap((slot, index) => slot.existingId ? [prisma.action.update({
      where: { id: slot.existingId },
      data: { title: titles[index]!, milestoneId: milestoneFor(slot, index) },
    })] : []);
    const rows = slots.flatMap((slot, index) => slot.existingId ? [] : [{
      userId: routine.userId,
      goalId: routine.goalId,
      routineId: routine.id,
      milestoneId: milestoneFor(slot, index),
      title: titles[index]!,
      status: "UPCOMING" as const,
      priority: routine.goal.priority,
      scheduledFor: slot.scheduledFor,
      dueDate: slot.scheduledFor,
      preferredTime: routine.preferredTime ?? routine.goal.preferredTime,
      estimatedMinutes: routine.durationMinutes,
      difficulty: 2,
      frequency: "ONCE" as const,
    }]);
    if (updates.length) await prisma.$transaction(updates);
    if (rows.length) created += (await prisma.action.createMany({ data: rows, skipDuplicates: true })).count;
  }
  return created;
}

export async function markOverdueActionsMissed(now = new Date()) {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      actions: { where: { deletedAt: null, status: { in: ["UPCOMING", "IN_PROGRESS"] } }, select: { id: true, goalId: true, scheduledFor: true, dueDate: true } },
    },
  });
  let missed = 0;
  for (const user of users) {
    const overdue = user.actions.filter((action) => {
      const planned = action.scheduledFor ?? action.dueDate;
      return planned !== null && planned < now;
    });
    if (!overdue.length) continue;
    await prisma.$transaction([
      prisma.action.updateMany({ where: { id: { in: overdue.map((action) => action.id) }, userId: user.id }, data: { status: "MISSED" } }),
      prisma.progressRecord.createMany({ data: overdue.map((action) => ({ userId: user.id, goalId: action.goalId, actionId: action.id, status: "MISSED", occurredAt: now })) }),
      prisma.analyticsEvent.createMany({ data: overdue.map((action) => ({ userId: user.id, name: "action_status_changed", properties: { actionId: action.id, goalId: action.goalId, status: "MISSED" } })) }),
    ]);
    missed += overdue.length;
  }
  return missed;
}

export async function enqueueNotifications(now = new Date()) {
  const horizon = new Date(now.getTime() + 22 * 86_400_000);
  const users = await prisma.user.findMany({
    where: { notificationPrefs: { is: { pushEnabled: true } } },
    include: {
      notificationPrefs: true,
      actions: { where: { deletedAt: null, status: { in: ["UPCOMING", "IN_PROGRESS", "MISSED"] }, OR: [{ scheduledFor: { lte: horizon } }, { scheduledFor: null, dueDate: { lte: horizon } }] }, include: { goal: { select: { title: true, remindersEnabled: true } } } },
      milestones: { where: { deletedAt: null, status: { not: "COMPLETED" }, targetDate: { gte: now, lte: horizon } }, include: { goal: { select: { title: true, remindersEnabled: true } } } },
    },
  });
  const rows = [];
  for (const user of users) {
    const prefs = user.notificationPrefs!;
    for (const action of user.actions) {
      if (action.status === "MISSED") continue;
      if (!action.reminderEnabled || !action.goal.remindersEnabled) continue;
      const due = action.scheduledFor ?? action.dueDate;
      if (!due) continue;
      if (prefs.actionReminders) rows.push({ userId: user.id, type: "ACTION_REMINDER" as const, title: "A small step is coming up", body: `${action.title} · ${action.goal.title}`, scheduledAt: outsideQuietHours(user.timezone, new Date(due.getTime() - prefs.reminderMinutesBefore * 60_000), prefs.quietHoursStart, prefs.quietHoursEnd), dedupeKey: `action:${action.id}:reminder`, data: { actionId: action.id, goalId: action.goalId } });
      if (prefs.dueActionReminders) rows.push({ userId: user.id, type: "DUE_ACTION" as const, title: "Ready when you are", body: action.title, scheduledAt: outsideQuietHours(user.timezone, due, prefs.quietHoursStart, prefs.quietHoursEnd), dedupeKey: `action:${action.id}:due`, data: { actionId: action.id, goalId: action.goalId } });
    }
    if (prefs.milestoneReminders) for (const milestone of user.milestones) {
      if (!milestone.goal.remindersEnabled) continue;
      rows.push({ userId: user.id, type: "MILESTONE" as const, title: "Milestone approaching", body: `${milestone.title} · ${milestone.goal.title}`, scheduledAt: outsideQuietHours(user.timezone, new Date(milestone.targetDate!.getTime() - 86_400_000), prefs.quietHoursStart, prefs.quietHoursEnd), dedupeKey: `milestone:${milestone.id}:${milestone.targetDate!.toISOString()}`, data: { milestoneId: milestone.id, goalId: milestone.goalId } });
    }
    const today = timezoneDateParts(user.timezone, now);
    if (prefs.dueActionReminders) {
      const remaining = remainingTaskCount(
        user.timezone,
        now,
        user.actions
          .filter((action) => action.reminderEnabled && action.goal.remindersEnabled)
          .map((action) => action.scheduledFor ?? action.dueDate),
      );
      if (remaining) rows.push({
        userId: user.id,
        type: "SYSTEM" as const,
        title: remaining === 1 ? "One task is still open" : `${remaining} tasks are still open`,
        body: "Take one small step now, or reschedule what no longer fits today.",
        scheduledAt: outsideQuietHours(user.timezone, now, prefs.quietHoursStart, prefs.quietHoursEnd),
        dedupeKey: `remaining:${user.id}:${dateKey(today)}`,
        data: { remainingCount: remaining },
      });
    }
    let sunday = timezoneDateParts(user.timezone, now);
    while (new Date(Date.UTC(sunday.year, sunday.month - 1, sunday.day)).getUTCDay() !== 0) sunday = addDays(sunday, 1);
    if (prefs.progressSummaries) rows.push({ userId: user.id, type: "PROGRESS_SUMMARY" as const, title: "Your week in view", body: "See what moved and what may need a smaller next step.", scheduledAt: outsideQuietHours(user.timezone, zonedDateTime(user.timezone, sunday.year, sunday.month, sunday.day, 18), prefs.quietHoursStart, prefs.quietHoursEnd), dedupeKey: `summary:${user.id}:${dateKey(sunday)}` });
    if (prefs.weeklyReflection) rows.push({ userId: user.id, type: "WEEKLY_REFLECTION" as const, title: "A week is information", body: "Take a minute to notice what helped and choose next week’s focus.", scheduledAt: outsideQuietHours(user.timezone, zonedDateTime(user.timezone, sunday.year, sunday.month, sunday.day, 19), prefs.quietHoursStart, prefs.quietHoursEnd), dedupeKey: `reflection:${user.id}:${dateKey(sunday)}` });
  }
  if (!rows.length) return 0;
  await prisma.$transaction(rows.map((row) => prisma.notification.upsert({
    where: { dedupeKey: row.dedupeKey },
    create: row,
    update: { title: row.title, body: row.body, data: row.data, scheduledAt: row.scheduledAt },
  })));
  return rows.length;
}

export async function runMaintenance(now = new Date()) {
  const generated = await generateRoutineActions(now);
  const missed = await markOverdueActionsMissed(now);
  const queued = await enqueueNotifications(now);
  const sent = await dispatchDueNotifications(now);
  return { generated, missed, queued, sent };
}
