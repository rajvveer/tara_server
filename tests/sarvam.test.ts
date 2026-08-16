import { afterEach, describe, expect, it, vi } from "vitest";
import { startVoiceOnboarding, voiceOnboardingTurn } from "../src/sarvam.js";

const json = (value: unknown) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});

const wav = () => {
  const bytes = Buffer.alloc(200);
  bytes.write("RIFF", 0, "ascii");
  return bytes.toString("base64");
};

afterEach(() => vi.unstubAllGlobals());

describe("voice onboarding providers", () => {
  it("detects Hindi, merges a complete plan, and synthesizes the same-language reply", async () => {
    const targetDate = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(json({ transcript: "मैं हर सुबह दौड़ना चाहता हूँ", language_code: "bn-IN" }))
      .mockResolvedValueOnce(json({
        choices: [{ message: { content: JSON.stringify({
          reply: "बहुत अच्छा। आपकी योजना तैयार है। आगे बढ़ें।",
          answers: {
            name: "Aman",
            objective: "Run a first 5K",
            targetDate,
            preferredDays: ["Fri", "Mon", "Wed"],
            preferredTime: "08:00",
            workingFrequency: 3,
            progressStyle: "Gentle",
            constraints: "",
          },
        }) } }],
      }))
      .mockResolvedValueOnce(json({ audios: ["UklGRg=="] }));
    vi.stubGlobal("fetch", mockedFetch);

    const events: string[] = [];
    const result = await voiceOnboardingTurn(
      {
        audioBase64: wav(),
        mimeType: "audio/wav",
        answers: { name: "Aman" },
      },
      (event) => events.push(event.type),
    );

    expect(result.languageCode).toBe("hi-IN");
    expect(result.complete).toBe(true);
    expect(result.answers.preferredDays).toEqual(["Mon", "Wed", "Fri"]);
    expect(result.audioBase64).toBe("UklGRg==");
    expect(events).toEqual(["transcript", "reply"]);
    expect(mockedFetch).toHaveBeenCalledTimes(3);
    expect(mockedFetch.mock.calls[0]?.[0]).toBe("https://api.sarvam.ai/speech-to-text");
    expect(mockedFetch.mock.calls[1]?.[0]).toBe("https://api.groq.com/openai/v1/chat/completions");
    const aiRequest = mockedFetch.mock.calls[1]?.[1] as RequestInit;
    const aiBody = JSON.parse(String(aiRequest.body));
    expect(aiBody).toMatchObject({
      model: "openai/gpt-oss-120b",
      reasoning_effort: "low",
      response_format: { type: "json_schema", json_schema: { strict: true } },
    });
    expect(new Headers(aiRequest.headers).get("Authorization")).toMatch(/^Bearer .+/);
    const ttsBody = JSON.parse(String((mockedFetch.mock.calls[2]?.[1] as RequestInit).body));
    expect(ttsBody).toMatchObject({
      target_language_code: "hi-IN",
      speaker: "priya",
      pace: 1,
      temperature: 0.75,
      model: "bulbul:v3",
    });
  });

  it("uses an English transcript even when the provider mislabels it Hindi", async () => {
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(json({ transcript: "I want to lose weight", language_code: "hi-IN" }))
      .mockResolvedValueOnce(json({
        choices: [{ message: { content: JSON.stringify({
          reply: "बहुत बढ़िया। आप इसे किस तारीख तक पूरा करना चाहेंगे?",
          answers: {
            name: "Maya",
            objective: "Lose weight",
            targetDate: null,
            preferredDays: null,
            preferredTime: null,
            workingFrequency: null,
            progressStyle: null,
            constraints: null,
          },
        }) } }],
      }))
      .mockResolvedValueOnce(json({
        choices: [{ message: { content: JSON.stringify({
          reply: "Great goal. What date would you like to reach it by?",
        }) } }],
      }))
      .mockResolvedValueOnce(json({ audios: ["UklGRg=="] }));
    vi.stubGlobal("fetch", mockedFetch);

    const result = await voiceOnboardingTurn({
      audioBase64: wav(),
      mimeType: "audio/wav",
      answers: { name: "Maya" },
    });

    expect(result.languageCode).toBe("en-IN");
    expect(result.reply).toBe("Great goal. What date would you like to reach it by?");
    expect(mockedFetch).toHaveBeenCalledTimes(4);
    const ttsBody = JSON.parse(String((mockedFetch.mock.calls[3]?.[1] as RequestInit).body));
    expect(ttsBody).toMatchObject({ target_language_code: "en-IN", speaker: "ishita" });
  });

  it("stores a spoken weekly frequency before asking the next question", async () => {
    const targetDate = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(json({ transcript: "Three days", language_code: "en-IN" }))
      .mockResolvedValueOnce(json({
        choices: [{ message: { content: JSON.stringify({
          reply: "Three days a week works. Which weekdays suit you best?",
          answers: {
            name: "Lalit",
            objective: "Lose weight",
            targetDate,
            preferredDays: null,
            preferredTime: null,
            workingFrequency: null,
            progressStyle: null,
            constraints: null,
          },
        }) } }],
      }))
      .mockResolvedValueOnce(json({ audios: ["UklGRg=="] }));
    vi.stubGlobal("fetch", mockedFetch);

    const result = await voiceOnboardingTurn({
      audioBase64: wav(),
      mimeType: "audio/wav",
      answers: { name: "Lalit", objective: "Lose weight", targetDate },
    });

    expect(result.answers.workingFrequency).toBe(3);
    const aiBody = JSON.parse(String((mockedFetch.mock.calls[1]?.[1] as RequestInit).body));
    expect(JSON.parse(aiBody.messages[1].content).currentAnswers.workingFrequency).toBe(3);
  });

  it("keeps a multi-step goal and repairs a repeated goal question", async () => {
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(json({
        transcript: "My goal is to create an app and publish it to the App Store",
        language_code: "en-IN",
      }))
      .mockResolvedValueOnce(json({
        choices: [{ message: { content: JSON.stringify({
          reply: "What is your goal?",
          answers: {
            name: "Aman",
            objective: null,
            targetDate: null,
            preferredDays: null,
            preferredTime: null,
            workingFrequency: null,
            progressStyle: null,
            constraints: null,
          },
        }) } }],
      }))
      .mockResolvedValueOnce(json({
        choices: [{ message: { content: JSON.stringify({
          reply: "Creating and publishing your app is clear. When would you like it live?",
        }) } }],
      }))
      .mockResolvedValueOnce(json({ audios: ["UklGRg=="] }));
    vi.stubGlobal("fetch", mockedFetch);

    const result = await voiceOnboardingTurn({
      audioBase64: wav(),
      mimeType: "audio/wav",
      answers: { name: "Aman" },
    });

    expect(result.answers.objective).toBe("create an app and publish it to the App Store");
    expect(result.reply).toContain("Creating and publishing your app");
    const aiBody = JSON.parse(String((mockedFetch.mock.calls[1]?.[1] as RequestInit).body));
    expect(JSON.parse(aiBody.messages[1].content).currentAnswers.objective)
      .toBe("create an app and publish it to the App Store");
    expect(mockedFetch).toHaveBeenCalledTimes(4);
  });

  it("preserves 11am and repairs a repeated time-choice question", async () => {
    const targetDate = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(json({ transcript: "11am", language_code: "en-IN" }))
      .mockResolvedValueOnce(json({
        choices: [{ message: { content: JSON.stringify({
          reply: "Would you prefer morning, afternoon, or evening?",
          answers: {
            name: "Aman",
            objective: "Build and publish an app",
            targetDate,
            preferredDays: ["Mon", "Wed", "Fri"],
            preferredTime: null,
            workingFrequency: 3,
            progressStyle: null,
            constraints: null,
          },
        }) } }],
      }))
      .mockResolvedValueOnce(json({
        choices: [{ message: { content: JSON.stringify({
          reply: "11am works. How much progress detail would you like?",
        }) } }],
      }))
      .mockResolvedValueOnce(json({ audios: ["UklGRg=="] }));
    vi.stubGlobal("fetch", mockedFetch);

    const result = await voiceOnboardingTurn({
      audioBase64: wav(),
      mimeType: "audio/wav",
      answers: {
        name: "Aman",
        objective: "Build and publish an app",
        targetDate,
        preferredDays: ["Mon", "Wed", "Fri"],
        workingFrequency: 3,
      },
    });

    expect(result.answers.preferredTime).toBe("11:00");
    expect(result.reply).toContain("11am works");
    const aiBody = JSON.parse(String((mockedFetch.mock.calls[1]?.[1] as RequestInit).body));
    expect(JSON.parse(aiBody.messages[1].content).currentAnswers.preferredTime).toBe("11:00");
    expect(mockedFetch).toHaveBeenCalledTimes(4);
  });

  it("does not mistake Bengali text with a shared danda for Hindi", async () => {
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(json({ transcript: "আমি ওজন কমাতে চাই।", language_code: "hi-IN" }))
      .mockResolvedValueOnce(json({
        choices: [{ message: { content: JSON.stringify({
          reply: "দারুণ লক্ষ্য। আপনি কবে এটি অর্জন করতে চান?",
          answers: {
            name: "Maya",
            objective: "Lose weight",
            targetDate: null,
            preferredDays: null,
            preferredTime: null,
            workingFrequency: null,
            progressStyle: null,
            constraints: null,
          },
        }) } }],
      }))
      .mockResolvedValueOnce(json({ audios: ["UklGRg=="] }));
    vi.stubGlobal("fetch", mockedFetch);

    const result = await voiceOnboardingTurn({
      audioBase64: wav(),
      mimeType: "audio/wav",
      answers: { name: "Maya" },
    });

    expect(result.languageCode).toBe("bn-IN");
    const ttsBody = JSON.parse(String((mockedFetch.mock.calls[2]?.[1] as RequestInit).body));
    expect(ttsBody).toMatchObject({ target_language_code: "bn-IN", speaker: "roopa" });
  });

  it("uses a Hindi opening prompt for a Hindi device locale", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ audios: ["UklGRg=="] })));
    const result = await startVoiceOnboarding("hi_IN");
    expect(result.languageCode).toBe("hi-IN");
    expect(result.reply).toMatch(/[\u0900-\u097F]/);
  });

  it("greets the signed-in user without asking for their name", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ audios: ["UklGRg=="] })));
    const result = await startVoiceOnboarding("en-IN", "Maya Singh");
    expect(result.reply).toContain("Hi Maya!");
    expect(result.reply).toContain("I’m Tara, your GoalSpring coach.");
    expect(result.reply).not.toMatch(/name|call you/i);
  });

  it("rejects malformed audio before spending provider credits", async () => {
    const mockedFetch = vi.fn();
    vi.stubGlobal("fetch", mockedFetch);
    await expect(voiceOnboardingTurn({
      audioBase64: Buffer.alloc(200).toString("base64"),
      mimeType: "audio/wav",
      answers: {},
    })).rejects.toMatchObject({ code: "INVALID_AUDIO", status: 422 });
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
