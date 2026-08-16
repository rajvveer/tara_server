import { z } from "zod";
import { config } from "./config.js";

export type GoalActionPlanInput = {
  title: string;
  description: string | null;
  whyItMatters: string | null;
  category: string;
  customCategory: string | null;
  frequency: string;
  weeklyTarget: number;
  preferredDays: string[];
  preferredTime: string | null;
  durationMinutes: number | null;
  targetDate: string | null;
  constraints: string | null;
  milestones: Array<{ title: string; targetDate: string | null }>;
  existingTitles: string[];
  dates: string[];
};

const completionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string() }),
  })).min(1),
});

const taskListSchema = z.object({
  tasks: z.array(z.string().trim().min(1).max(160)).max(40),
});

const fallbackPatterns = [
  (goal: string) => `Clarify the next result for ${goal}`,
  (goal: string) => `Prepare what you need for ${goal}`,
  (goal: string, minutes: number) => `Complete a focused ${minutes}-minute step toward ${goal}`,
  (goal: string) => `Practice the core skill behind ${goal}`,
  () => "Review progress and remove one blocker",
  (goal: string) => `Improve the weakest part of ${goal}`,
  () => "Apply what you learned to the next step",
  () => "Test your progress and record the result",
  (goal: string) => `Finish one visible piece of ${goal}`,
  () => "Reflect on the result and choose the next challenge",
];

function cleanTitle(value: string) {
  return value
    .replace(/^\s*(?:[-*]|\d+[.)])\s*/, "")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "")
    .replace(/\s+(?:on|for)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function fallbackTitle(input: GoalActionPlanInput, index: number) {
  const pattern = fallbackPatterns[index % fallbackPatterns.length]!;
  const cycle = Math.floor(index / fallbackPatterns.length);
  const title = pattern(input.title, input.durationMinutes ?? 30);
  return cleanTitle(cycle ? `${title} · phase ${cycle + 1}` : title);
}

function completePlan(input: GoalActionPlanInput, generated: string[] = []) {
  const used = new Set(input.existingTitles.map((title) => title.trim().toLocaleLowerCase()));
  return input.dates.map((_, index) => {
    let title = cleanTitle(generated[index] ?? "");
    if (!title || /^continue\b/i.test(title) || used.has(title.toLocaleLowerCase())) {
      title = fallbackTitle(input, index);
    }
    let collision = 1;
    while (used.has(title.toLocaleLowerCase())) {
      title = cleanTitle(`${fallbackTitle(input, index).slice(0, 130)} · session ${index + 1}-${collision++}`);
    }
    used.add(title.toLocaleLowerCase());
    return title;
  });
}

export async function generateGoalActionTitles(input: GoalActionPlanInput) {
  if (!input.dates.length) return [];
  if (!config.GROQ_API_KEY) return completePlan(input);

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        temperature: 0.6,
        max_completion_tokens: Math.min(1_800, Math.max(400, input.dates.length * 80)),
        reasoning_effort: "low",
        response_format: { type: "json_object" },
        messages: [{
          role: "system",
          content: "You create realistic, progressive action plans for personal goals. Return JSON only as {\"tasks\":[\"...\"]}. Return exactly one task per supplied date, in the same order. Every title must be different, begin with a clear action verb, fit the session duration, and be specific enough to do without guessing. Use the outcome, motivation, constraints, milestones, deadline, cadence, and earlier actions. Move from setup to practice to review and improvement; align work with the next milestone. Never write 'Continue [goal]', repeat a title, add a date to a title, or invent purchases, medical advice, or facts. Keep each title under 90 characters and use the same language as the goal details.",
        }, {
          role: "user",
          content: JSON.stringify(input),
        }],
      }),
    });
    if (!response.ok) return completePlan(input);
    const completion = completionSchema.safeParse(await response.json());
    if (!completion.success) return completePlan(input);
    const content = completion.data.choices[0]!.message.content;
    const json = content.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return completePlan(input);
    const plan = taskListSchema.safeParse(JSON.parse(json));
    return completePlan(input, plan.success ? plan.data.tasks : []);
  } catch {
    return completePlan(input);
  }
}
