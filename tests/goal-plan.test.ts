import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({ config: { GROQ_API_KEY: "test-key" } }));

import { generateGoalActionTitles, type GoalActionPlanInput } from "../src/goal-plan.js";

const input: GoalActionPlanInput = {
  title: "Run my first 5K",
  description: "Finish without stopping",
  whyItMatters: "Feel stronger",
  category: "HEALTH",
  customCategory: null,
  frequency: "WEEKLY",
  weeklyTarget: 3,
  preferredDays: ["MONDAY", "WEDNESDAY", "FRIDAY"],
  preferredTime: "07:00",
  durationMinutes: 30,
  targetDate: "2026-10-01T00:00:00.000Z",
  constraints: "Beginner runner",
  milestones: [{ title: "Run 2K comfortably", targetDate: "2026-09-01T00:00:00.000Z" }],
  existingTitles: ["Buy running shoes"],
  dates: ["2026-08-17", "2026-08-19", "2026-08-21"],
};

afterEach(() => vi.unstubAllGlobals());

describe("AI goal plan", () => {
  it("returns one distinct task for every scheduled day", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ tasks: [
        "Walk and jog for 20 minutes on 2026-08-17",
        "Practice an easy run-walk rhythm",
        "Run 2K at a conversational pace",
      ] }) } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateGoalActionTitles(input)).resolves.toEqual([
      "Walk and jog for 20 minutes",
      "Practice an easy run-walk rhythm",
      "Run 2K at a conversational pace",
    ]);
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.messages[1].content).toContain("Run my first 5K");
    expect(body.messages[1].content).toContain("Beginner runner");
    expect(body.max_completion_tokens).toBe(400);
  });

  it("falls back to varied tasks when the provider response is unusable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 503 })));
    const titles = await generateGoalActionTitles(input);
    expect(new Set(titles).size).toBe(input.dates.length);
    expect(titles.every((title) => !title.startsWith("Continue "))).toBe(true);
  });
});
