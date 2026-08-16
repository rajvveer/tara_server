import { describe, expect, it } from "vitest";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/onward";
process.env.JWT_SECRET ??= "maintenance-test-secret-that-is-long-enough";
const { outsideQuietHours, remainingTaskCount, shouldScheduleRoutine } = await import("../src/maintenance.js");

const createdAt = new Date("2026-01-31T08:00:00.000Z");

describe("routine scheduling", () => {
  it("uses selected weekdays for weekly and custom routines", () => {
    const rule = { frequency: "WEEKLY" as const, days: ["MONDAY", "FRIDAY"], timesPerWeek: 2, createdAt };
    expect(shouldScheduleRoutine(rule, { year: 2026, month: 8, day: 14 }, "UTC+00:00")).toBe(true);
    expect(shouldScheduleRoutine(rule, { year: 2026, month: 8, day: 15 }, "UTC+00:00")).toBe(false);
  });

  it("schedules daily routines every day", () => {
    const rule = { frequency: "DAILY" as const, days: [], timesPerWeek: 7, createdAt };
    expect(shouldScheduleRoutine(rule, { year: 2026, month: 8, day: 15 }, "Asia/Kolkata")).toBe(true);
  });

  it("keeps daily plans on explicitly selected weekdays", () => {
    const rule = { frequency: "DAILY" as const, days: ["MONDAY", "FRIDAY"], timesPerWeek: 2, createdAt };
    expect(shouldScheduleRoutine(rule, { year: 2026, month: 8, day: 14 }, "UTC+00:00")).toBe(true);
    expect(shouldScheduleRoutine(rule, { year: 2026, month: 8, day: 15 }, "UTC+00:00")).toBe(false);
  });

  it("clamps month-end routines to the last calendar day", () => {
    const rule = { frequency: "MONTHLY" as const, days: [], timesPerWeek: 1, createdAt };
    expect(shouldScheduleRoutine(rule, { year: 2026, month: 2, day: 28 }, "UTC+00:00")).toBe(true);
    expect(shouldScheduleRoutine(rule, { year: 2026, month: 2, day: 27 }, "UTC+00:00")).toBe(false);
  });

  it("defers notifications until quiet hours end in the user's timezone", () => {
    const atElevenPmIst = new Date("2026-08-13T17:30:00.000Z");
    expect(outsideQuietHours("Asia/Kolkata", atElevenPmIst, "22:00", "07:00").toISOString()).toBe("2026-08-14T01:30:00.000Z");
  });

  it("summarizes unfinished tasks after 8 PM in the user's local day", () => {
    const dueToday = new Date("2026-08-16T06:30:00.000Z");
    const dueYesterday = new Date("2026-08-15T06:30:00.000Z");
    expect(remainingTaskCount("Asia/Kolkata", new Date("2026-08-16T14:00:00.000Z"), [dueToday])).toBe(0);
    expect(remainingTaskCount("Asia/Kolkata", new Date("2026-08-16T15:00:00.000Z"), [dueToday, dueYesterday, null])).toBe(1);
  });
});
