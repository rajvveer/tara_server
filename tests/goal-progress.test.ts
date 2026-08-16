import { describe, expect, it } from "vitest";
import { calculateGoalProgress, formatRelativeTimezoneDateTime, formatTimezoneDateTime, timezoneDayRange, timezoneMonthRange, timezoneWeekRange } from "../src/goal-progress.js";

const now = new Date("2026-08-12T12:00:00.000Z");
const baseGoal = {
  status: "ACTIVE" as const,
  startDate: new Date("2026-08-01T00:00:00.000Z"),
  targetDate: new Date("2026-08-31T00:00:00.000Z"),
  frequency: "WEEKLY" as const,
  weeklyTarget: 4,
};

describe("goal progress", () => {
  it("does not count future upcoming actions against adherence", () => {
    const result = calculateGoalProgress(baseGoal, [
      { status: "COMPLETED", scheduledFor: new Date("2026-08-04T10:00:00.000Z") },
      { status: "COMPLETED", scheduledFor: new Date("2026-08-08T10:00:00.000Z") },
      { status: "UPCOMING", scheduledFor: new Date("2026-08-20T10:00:00.000Z") },
      { status: "UPCOMING", scheduledFor: new Date("2026-08-25T10:00:00.000Z") },
    ], now);
    expect(result.adherence).toBe(100);
    expect(result.cadence.dueActions).toBe(2);
  });

  it("flags missed due work even when raw completion looks healthy", () => {
    const result = calculateGoalProgress({ ...baseGoal, startDate: new Date("2026-08-09T00:00:00.000Z"), targetDate: new Date("2026-09-30T00:00:00.000Z"), weeklyTarget: 3 }, [
      { status: "COMPLETED", scheduledFor: new Date("2026-08-09T10:00:00.000Z") },
      { status: "COMPLETED", scheduledFor: new Date("2026-08-10T10:00:00.000Z") },
      { status: "MISSED", scheduledFor: new Date("2026-08-11T10:00:00.000Z") },
      { status: "MISSED", scheduledFor: new Date("2026-08-12T09:00:00.000Z") },
      { status: "UPCOMING", scheduledFor: new Date("2026-08-20T10:00:00.000Z") },
    ], now);
    expect(result.progress).toBe(40);
    expect(result.adherence).toBe(50);
    expect(["NEEDS_ATTENTION", "BEHIND"]).toContain(result.status);
  });

  it("uses weekly target when estimating expected progress", () => {
    const actions = Array.from({ length: 12 }, (_, index) => ({ status: index < 2 ? "COMPLETED" as const : "UPCOMING" as const, scheduledFor: new Date(`2026-09-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`) }));
    const gentle = calculateGoalProgress({ ...baseGoal, weeklyTarget: 1 }, actions, now);
    const ambitious = calculateGoalProgress({ ...baseGoal, weeklyTarget: 5 }, actions, now);
    expect(ambitious.expectedProgress).toBeGreaterThan(gentle.expectedProgress);
  });

  it("uses a configured numeric target as the goal completion source", () => {
    const metricGoal = { ...baseGoal, metricTarget: 100, metricCurrent: 25 };
    const result = calculateGoalProgress(metricGoal, [
      { status: "COMPLETED" as const, scheduledFor: new Date("2026-08-04T10:00:00.000Z") },
      { status: "COMPLETED" as const, scheduledFor: new Date("2026-08-08T10:00:00.000Z") },
    ], now);
    expect(result.progress).toBe(25);
    expect(calculateGoalProgress({ ...metricGoal, metricCurrent: 100 }, [], now).status).toBe("COMPLETED");
  });

  it("finds local day boundaries across half-hour timezones", () => {
    const range = timezoneDayRange("Asia/Kolkata", new Date("2026-08-12T20:00:00.000Z"));
    expect(range.start.toISOString()).toBe("2026-08-12T18:30:00.000Z");
    expect(range.end.toISOString()).toBe("2026-08-13T18:30:00.000Z");
  });

  it("supports safe positive and negative fixed-offset day boundaries", () => {
    const positive = timezoneDayRange("UTC+05:30", new Date("2026-08-12T20:00:00.000Z"));
    const negative = timezoneDayRange("UTC-07:00", new Date("2026-08-12T06:30:00.000Z"));
    expect([positive.start.toISOString(), positive.end.toISOString()]).toEqual(["2026-08-12T18:30:00.000Z", "2026-08-13T18:30:00.000Z"]);
    expect([negative.start.toISOString(), negative.end.toISOString()]).toEqual(["2026-08-11T07:00:00.000Z", "2026-08-12T07:00:00.000Z"]);
  });

  it("formats task timestamps as local wall-clock values", () => {
    const instant = new Date("2026-08-17T02:30:00.000Z");
    expect(formatTimezoneDateTime("Asia/Kolkata", instant)).toBe("2026-08-17 08:00");
    expect(formatTimezoneDateTime("UTC+05:30", instant)).toBe("2026-08-17 08:00");
    expect(formatTimezoneDateTime("UTC-07:00", instant)).toBe("2026-08-16 19:30");
    expect(formatRelativeTimezoneDateTime("Asia/Kolkata", instant, new Date("2026-08-16T12:00:00.000Z"))).toBe("tomorrow at 8:00 AM");
    expect(formatRelativeTimezoneDateTime("UTC-07:00", instant, new Date("2026-08-17T08:00:00.000Z"))).toBe("yesterday at 7:30 PM");
  });

  it("uses IST calendar boundaries for weekly and monthly progress", () => {
    const atLocalMonday = new Date("2026-08-02T20:00:00.000Z");
    const week = timezoneWeekRange("Asia/Kolkata", atLocalMonday, 1);
    const month = timezoneMonthRange("Asia/Kolkata", atLocalMonday);
    expect([week.start.toISOString(), week.end.toISOString()]).toEqual(["2026-08-02T18:30:00.000Z", "2026-08-09T18:30:00.000Z"]);
    expect([month.start.toISOString(), month.end.toISOString()]).toEqual(["2026-07-31T18:30:00.000Z", "2026-08-31T18:30:00.000Z"]);
  });
});
