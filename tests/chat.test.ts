import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), executeTool: vi.fn() }));

vi.mock("../src/config.js", () => ({
  config: { GROQ_API_KEY: "test-groq-key" },
}));
vi.mock("../src/db.js", () => ({
  prisma: { user: { findUnique: mocks.findUnique } },
}));
vi.mock("../src/coach-tools.js", () => ({
  coachTools: [{
    type: "function",
    function: {
      name: "update_task",
      description: "Update a task",
      parameters: { type: "object", properties: {} },
    },
  }],
  executeCoachTool: mocks.executeTool,
}));

import { chatTurnSchema, streamCoachReply } from "../src/chat.js";

const accountContext = {
  name: "Mira Patel",
  mainObjective: "Run a first 5K",
  timezone: "Asia/Kolkata",
  preferences: { preferredDays: ["Mon", "Wed", "Fri"] },
  goals: [{
    title: "First 5K",
    description: "Build running consistency",
    whyItMatters: "Feel energetic",
    category: "Fitness",
    status: "ACTIVE",
    targetDate: new Date("2026-10-01T00:00:00.000Z"),
    weeklyTarget: 3,
    preferredDays: ["Mon", "Wed", "Fri"],
    preferredTime: "Morning",
    milestones: [],
    actions: [],
  }],
};

beforeEach(() => mocks.findUnique.mockResolvedValue(accountContext));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("personalized coach", () => {
  it("streams reply deltas and supplies private goal context server-side", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T20:00:00.000Z"));
    const fetchMock = vi.fn().mockResolvedValue(new Response([
      'data: {"choices":[{"delta":{"content":"Take a "}}]}',
      "",
      "data: this malformed provider line is ignored",
      "",
      'data: {"choices":[{"delta":{"content":"10-minute walk."}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const deltas: string[] = [];

    const reply = await streamCoachReply("user-1", {
      message: "What should I do next?",
      history: [{ role: "assistant", content: "Let's make today manageable." }],
    }, (text) => deltas.push(text));

    expect(reply).toBe("Take a 10-minute walk.");
    expect(deltas).toEqual(["Take a 10-minute walk."]);
    expect(mocks.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "user-1" },
    }));
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body).toMatchObject({
      model: "openai/gpt-oss-120b",
      stream: true,
      reasoning_effort: "low",
    });
    expect(body.messages[0].content).toContain("First 5K");
    expect(body.messages[0].content).toContain("You are Tara");
    expect(body.messages[0].content).toContain("GitHub-Flavored Markdown");
    expect(body.messages[0].content).toContain("The user's local date is 2026-08-17");
    expect(body.messages[0].content).toContain("localScheduledFor");
    expect(body.messages[0].content).toContain("scheduleLabel");
    expect(body.messages[0].content).toContain("ask only one focused question at a time");
    expect(body.messages[0].content).toContain("Never show ISO timestamps, timezone names, UTC offsets");
    expect(body.messages[0].content).toContain("Do not prefix task titles with symbols");
    expect(body.messages.at(-1)).toEqual({
      role: "user",
      content: "What should I do next?",
    });
  });

  it("bounds conversation history", () => {
    expect(chatTurnSchema.safeParse({
      message: "Hello",
      history: Array.from({ length: 13 }, () => ({
        role: "user",
        content: "Earlier message",
      })),
    }).success).toBe(false);
  });

  it("keeps only compact recent history in provider requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response([
      'data: {"choices":[{"delta":{"content":"Let’s continue."}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const history = Array.from({ length: 8 }, (_, index) => ({
      role: (index % 2 ? "assistant" : "user") as "assistant" | "user",
      content: String(index).repeat(1_500),
    }));

    await streamCoachReply("user-1", { message: "Continue", history }, () => undefined);

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    const suppliedHistory = body.messages.slice(1, -1);
    expect(suppliedHistory).toHaveLength(6);
    expect(suppliedHistory.every((message: { content: string }) => message.content.length === 1_000)).toBe(true);
  });

  it("answers a direct next-action question from the saved schedule without the provider", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00.000Z"));
    mocks.findUnique.mockResolvedValue({
      ...accountContext,
      goals: [{
        ...accountContext.goals[0],
        actions: [{
          title: "Warm up and jog 2km at easy pace",
          status: "UPCOMING",
          scheduledFor: new Date("2026-08-17T13:30:00.000Z"),
          estimatedMinutes: 30,
        }],
      }],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const deltas: string[] = [];

    const reply = await streamCoachReply("user-1", {
      message: "What's my next action?",
      history: [],
    }, (text) => deltas.push(text));

    expect(reply).toBe("Your next action is tomorrow at 7:00 PM: Warm up and jog 2km at easy pace. It should take about 30 minutes.");
    expect(deltas).toEqual([reply]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it("turns overwhelm into one small read-only step without calling the provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const reply = await streamCoachReply("user-1", {
      message: "I feel overwhelmed. Give me one small step.",
      history: [],
    }, () => undefined);

    expect(reply).toBe("Take five minutes to write down the smallest useful thing you could do next, then stop there.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it("answers tomorrow questions in natural Roman Hinglish without calling the provider", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00.000Z"));
    mocks.findUnique.mockResolvedValue({
      ...accountContext,
      goals: [{
        ...accountContext.goals[0],
        actions: [{
          title: "Set up Android Studio",
          status: "UPCOMING",
          scheduledFor: new Date("2026-08-17T02:30:00.000Z"),
          estimatedMinutes: 30,
        }],
      }],
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const reply = await streamCoachReply("user-1", {
      message: "Kal mujhe kya karna hai?",
      history: [],
    }, () => undefined);

    expect(reply).toBe("Kal subah 8 baje **Set up Android Studio**. Isme lagbhag 30 minute lagenge.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a short provider rate limit instead of failing the chat", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response([
        'data: {"choices":[{"delta":{"content":"Ready when you are."}}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(streamCoachReply("user-1", {
      message: "What should I do next?",
      history: [],
    }, () => undefined)).resolves.toBe("Ready when you are.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to the smaller tool-capable model on a long primary limit", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "999" } }))
      .mockResolvedValueOnce(new Response([
        'data: {"choices":[{"delta":{"content":"I’m ready."}}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(streamCoachReply("user-1", {
      message: "Help me plan.",
      history: [],
    }, () => undefined)).resolves.toBe("I’m ready.");
    const fallbackBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(fallbackBody.model).toBe("openai/gpt-oss-20b");
  });

  it("retries an empty provider stream once", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("data: [DONE]\n\n", { status: 200 }))
      .mockResolvedValueOnce(new Response([
        'data: {"choices":[{"delta":{"content":"Let’s take one small step."}}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(streamCoachReply("user-1", {
      message: "I feel stuck.",
      history: [],
    }, () => undefined)).resolves.toBe("Let’s take one small step.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    const retryBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(firstBody.max_completion_tokens).toBe(700);
    expect(retryBody.max_completion_tokens).toBe(1_400);
  });

  it("executes streamed tool calls and reports data changes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"update_task","arguments":"{\\"taskId\\":\\"action-1\\","}}]}}]}',
        "",
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"status\\":\\"COMPLETED\\"}"}}]}}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"), { status: 200 }))
      .mockResolvedValueOnce(new Response([
        'data: {"choices":[{"delta":{"content":"Done — task completed."}}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.executeTool.mockResolvedValue({
      content: { task: { title: "Take a walk", status: "COMPLETED" } },
      changed: true,
    });
    const deltas: string[] = [];
    const changed = vi.fn();

    const reply = await streamCoachReply("user-1", {
      message: "Mark my walk complete",
      history: [],
    }, (text) => deltas.push(text), changed);

    expect(reply).toBe("Done — task completed.");
    expect(deltas).toEqual(["Done — task completed."]);
    expect(mocks.executeTool).toHaveBeenCalledWith(
      "user-1",
      "update_task",
      '{"taskId":"action-1","status":"COMPLETED"}',
      "Mark my walk complete",
      "Asia/Kolkata",
    );
    expect(changed).toHaveBeenCalledOnce();
    const finalBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(finalBody.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "call-1" }),
    ]));
  });

  it("uses the tool result when the wording pass stays empty", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-2","function":{"name":"update_task","arguments":"{\\"taskId\\":\\"action-1\\",\\"estimatedMinutes\\":25}"}}]}}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"), { status: 200 }))
      .mockImplementation(() => Promise.resolve(new Response("data: [DONE]\n\n", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    mocks.executeTool.mockResolvedValue({
      content: { task: { title: "Take a walk", status: "UPCOMING", estimatedMinutes: 25 } },
      changed: true,
    });
    const deltas: string[] = [];

    const reply = await streamCoachReply("user-1", {
      message: "Make my walk 25 minutes",
      history: [],
    }, (text) => deltas.push(text));

    expect(reply).toBe("Done — “Take a walk” should now take about 25 minutes.");
    expect(deltas).toEqual([reply]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("supports a lookup tool followed by a mutation tool", async () => {
    const toolResponse = (id: string, name: string, args: string) => new Response([
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"${id}","function":{"name":"${name}","arguments":${JSON.stringify(args)}}}]}}]}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"), { status: 200 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(toolResponse("call-list", "list_tasks", '{"scope":"ALL","status":"OPEN"}'))
      .mockResolvedValueOnce(toolResponse("call-update", "update_task", '{"taskId":"action-1","estimatedMinutes":25}'))
      .mockResolvedValueOnce(new Response([
        'data: {"choices":[{"delta":{"content":"Done — your walk now takes 25 minutes."}}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.executeTool
      .mockResolvedValueOnce({ content: { tasks: [{ id: "action-1", title: "Take a walk" }] }, changed: false })
      .mockResolvedValueOnce({ content: { task: { title: "Take a walk", estimatedMinutes: 25 } }, changed: true });

    const reply = await streamCoachReply("user-1", {
      message: "Make my walk 25 minutes",
      history: [],
    }, () => undefined);

    expect(reply).toBe("Done — your walk now takes 25 minutes.");
    expect(mocks.executeTool.mock.calls.map((call) => call[1])).toEqual(["list_tasks", "update_task"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
