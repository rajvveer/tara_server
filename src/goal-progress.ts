import type { ActionStatus, Frequency, GoalStatus } from "@prisma/client";

type GoalInput = {
  status: GoalStatus;
  startDate: Date;
  targetDate: Date | null;
  frequency: Frequency;
  weeklyTarget: number;
  metricTarget?: number | null;
  metricCurrent?: number | null;
};

type ActionInput = { status: ActionStatus; scheduledFor?: Date | null; dueDate?: Date | null };

export type GoalProgressStatus = "ON_TRACK" | "NEEDS_ATTENTION" | "BEHIND" | "AHEAD" | "COMPLETED";

const clamp = (value: number) => Math.min(1, Math.max(0, value));

function cadenceExpected(goal: GoalInput, now: Date) {
  const elapsedDays = Math.max(0, (now.getTime() - goal.startDate.getTime()) / 86_400_000);
  switch (goal.frequency) {
    case "ONCE": return now >= goal.startDate ? 1 : 0;
    case "DAILY": return Math.floor(elapsedDays) + 1;
    case "MONTHLY": return Math.floor(elapsedDays / 30) + 1;
    case "WEEKLY":
    case "CUSTOM": return Math.floor((elapsedDays / 7) * goal.weeklyTarget);
  }
}

/**
 * Status uses three signals: total completion, expected progress from the goal
 * timeframe/cadence, and adherence to occurrences already due. Future actions
 * never lower adherence.
 */
export function calculateGoalProgress(goal: GoalInput, actions: ActionInput[], now = new Date()) {
  const completed = actions.filter((action) => action.status === "COMPLETED").length;
  const missed = actions.filter((action) => action.status === "MISSED").length;
  const skipped = actions.filter((action) => action.status === "SKIPPED").length;
  const total = actions.length;
  const metricProgress = goal.metricTarget && goal.metricTarget > 0
    ? clamp((goal.metricCurrent ?? 0) / goal.metricTarget)
    : null;
  const progress = metricProgress ?? (total === 0 ? 0 : completed / total);

  const dueActions = actions.filter((action) => {
    const plannedAt = action.scheduledFor ?? action.dueDate;
    return plannedAt !== null && plannedAt !== undefined && plannedAt <= now;
  });
  const dueCompleted = dueActions.filter((action) => action.status === "COMPLETED").length;
  const adherence = dueActions.length === 0 ? 1 : dueCompleted / dueActions.length;

  const duration = goal.targetDate ? goal.targetDate.getTime() - goal.startDate.getTime() : 0;
  const timeframeExpected = duration > 0 ? clamp((now.getTime() - goal.startDate.getTime()) / duration) : 0;
  const expectedActionsByNow = Math.min(total, Math.max(dueActions.length, cadenceExpected(goal, now)));
  const cadenceProgress = total === 0 ? 0 : expectedActionsByNow / total;
  const expectedProgress = Math.max(timeframeExpected, cadenceProgress);

  let status: GoalProgressStatus;
  if (goal.status === "COMPLETED" || metricProgress === 1 || (metricProgress === null && total > 0 && completed === total)) status = "COMPLETED";
  else if (progress >= expectedProgress + 0.1 && adherence >= 0.75) status = "AHEAD";
  else if (progress + 0.15 < expectedProgress || (dueActions.length > 0 && adherence < 0.5)) status = "BEHIND";
  else if (progress + 0.05 < expectedProgress || (dueActions.length > 0 && adherence < 0.7)) status = "NEEDS_ATTENTION";
  else status = "ON_TRACK";

  return {
    status,
    progress: Math.round(progress * 100),
    expectedProgress: Math.round(clamp(expectedProgress) * 100),
    adherence: Math.round(adherence * 100),
    cadence: { frequency: goal.frequency, weeklyTarget: goal.weeklyTarget, expectedActionsByNow, dueActions: dueActions.length },
    counts: { total, completed, missed, skipped, remaining: total - completed - missed - skipped },
  };
}

function utcOffsetAt(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second")) - date.getTime();
}

function localMidnightUtc(year: number, month: number, day: number, timeZone: string) {
  const guess = new Date(Date.UTC(year, month - 1, day));
  const first = new Date(guess.getTime() - utcOffsetAt(guess, timeZone));
  return new Date(guess.getTime() - utcOffsetAt(first, timeZone));
}

function fixedOffsetMinutes(timeZone: string) {
  const match = /^UTC([+-])(\d{2}):(\d{2})$/.exec(timeZone);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
  return (match[1] === "+" ? 1 : -1) * (hours * 60 + minutes);
}

type LocalCalendar = { timeZone: string; offsetMinutes: number | null; year: number; month: number; day: number };

function localCalendar(timeZone: string, now: Date): LocalCalendar {
  const offsetMinutes = fixedOffsetMinutes(timeZone);
  if (offsetMinutes !== null) {
    const local = new Date(now.getTime() + offsetMinutes * 60_000);
    return { timeZone: "UTC", offsetMinutes, year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate() };
  }

  let resolvedTimeZone = timeZone;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  } catch {
    resolvedTimeZone = "UTC";
    parts = new Intl.DateTimeFormat("en-CA", { timeZone: resolvedTimeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  }
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { timeZone: resolvedTimeZone, offsetMinutes: null, year: value("year"), month: value("month"), day: value("day") };
}

function calendarMidnight(calendar: LocalCalendar, year: number, month: number, day: number) {
  if (calendar.offsetMinutes !== null) return new Date(Date.UTC(year, month - 1, day) - calendar.offsetMinutes * 60_000);
  return localMidnightUtc(year, month, day, calendar.timeZone);
}

export function timezoneDateParts(timeZone: string, now = new Date()) {
  const { year, month, day } = localCalendar(timeZone, now);
  return { year, month, day };
}

export function formatTimezoneDateTime(timeZone: string, date: Date) {
  const calendar = localCalendar(timeZone, date);
  if (calendar.offsetMinutes !== null) {
    const local = new Date(date.getTime() + calendar.offsetMinutes * 60_000);
    return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")} ${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: calendar.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
}

export function formatRelativeTimezoneDateTime(timeZone: string, date: Date, now = new Date()) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(formatTimezoneDateTime(timeZone, date));
  if (!match) throw new Error("Could not format local task time.");
  const year = Number(match[1]!);
  const month = Number(match[2]!);
  const day = Number(match[3]!);
  const hour = Number(match[4]!);
  const minute = Number(match[5]!);
  const current = timezoneDateParts(timeZone, now);
  const dayDifference = Math.round(
    (Date.UTC(year, month - 1, day) - Date.UTC(current.year, current.month - 1, current.day)) / 86_400_000,
  );
  const relativeDay = dayDifference === -1 ? "yesterday" : dayDifference === 0 ? "today" : dayDifference === 1 ? "tomorrow" : null;
  const calendarDay = relativeDay ?? new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(year === current.year ? {} : { year: "numeric" }),
  }).format(new Date(Date.UTC(year, month - 1, day)));
  const clock = `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
  return `${calendarDay} at ${clock}`;
}

export function zonedDateTime(timeZone: string, year: number, month: number, day: number, hour = 0, minute = 0) {
  const fixed = fixedOffsetMinutes(timeZone);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  if (fixed !== null) return new Date(target - fixed * 60_000);
  const safeZone = (() => {
    try { new Intl.DateTimeFormat("en", { timeZone }).format(); return timeZone; } catch { return "UTC"; }
  })();
  const guess = new Date(target);
  const first = new Date(target - utcOffsetAt(guess, safeZone));
  return new Date(target - utcOffsetAt(first, safeZone));
}

function shiftCalendarDate(year: number, month: number, day: number, days: number) {
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

export function timezoneDayRange(timeZone: string, now = new Date()) {
  const calendar = localCalendar(timeZone, now);
  const tomorrow = shiftCalendarDate(calendar.year, calendar.month, calendar.day, 1);
  return {
    start: calendarMidnight(calendar, calendar.year, calendar.month, calendar.day),
    end: calendarMidnight(calendar, tomorrow.year, tomorrow.month, tomorrow.day),
  };
}

export function timezoneWeekRange(timeZone: string, now = new Date(), weekStartsOn = 1) {
  const calendar = localCalendar(timeZone, now);
  const weekday = new Date(Date.UTC(calendar.year, calendar.month - 1, calendar.day)).getUTCDay();
  const startDate = shiftCalendarDate(calendar.year, calendar.month, calendar.day, -((weekday - weekStartsOn + 7) % 7));
  const endDate = shiftCalendarDate(startDate.year, startDate.month, startDate.day, 7);
  return {
    start: calendarMidnight(calendar, startDate.year, startDate.month, startDate.day),
    end: calendarMidnight(calendar, endDate.year, endDate.month, endDate.day),
  };
}

export function timezoneMonthRange(timeZone: string, now = new Date()) {
  const calendar = localCalendar(timeZone, now);
  const nextMonth = shiftCalendarDate(calendar.year, calendar.month + 1, 1, 0);
  return {
    start: calendarMidnight(calendar, calendar.year, calendar.month, 1),
    end: calendarMidnight(calendar, nextMonth.year, nextMonth.month, nextMonth.day),
  };
}
