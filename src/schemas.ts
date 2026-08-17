import { z } from "zod";

export const idParams = z.object({ id: z.string().cuid() });
export const goalIdParams = z.object({ goalId: z.string().cuid() });
export const goalAndIdParams = z.object({ goalId: z.string().cuid(), id: z.string().cuid() });

export const password = z.string().min(8).max(72);
export const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:mm format");
export const day = z.enum(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]);
export const priority = z.enum(["LOW", "MEDIUM", "HIGH"]);
export const frequency = z.enum(["ONCE", "DAILY", "WEEKLY", "MONTHLY", "CUSTOM"]);
export const date = z.coerce.date();
// Check null before the coercing date schema: `new Date(null)` is 1970-01-01.
export const optionalNullableDate = z.union([z.null(), date]).optional();

export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const registerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password,
  timezone: z.string().trim().min(1).max(64).default("UTC"),
});

export const loginSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(72),
});

export const googleAuthSchema = z.object({
  idToken: z.string().min(100).max(16_384),
  timezone: z.string().trim().min(1).max(64).default("UTC"),
}).strict();

export const appleAuthSchema = z.object({
  authorizationCode: z.string().min(1).max(4_096),
  identityToken: z.string().min(100).max(16_384),
  givenName: z.string().trim().max(80).optional(),
  familyName: z.string().trim().max(80).optional(),
  timezone: z.string().trim().min(1).max(64).default("UTC"),
  platform: z.enum(["ios", "android", "web"]),
  nonce: z.string().min(8).max(256).optional(),
}).strict();

const appleCallbackState = z.string().min(1).max(2_048);
export const appleCallbackSchema = z.union([
  z.object({
    code: z.string().min(1).max(4_096),
    id_token: z.string().min(100).max(16_384),
    state: appleCallbackState,
    user: z.string().max(8_192).optional(),
  }).strict(),
  z.object({
    error: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/),
    error_description: z.string().max(1_024).optional(),
    state: appleCallbackState,
  }).strict(),
]);

export const refreshSchema = z.object({ refreshToken: z.string().min(32).max(256) });
export const forgotPasswordSchema = z.object({ email: z.string().trim().email().transform((value) => value.toLowerCase()) });
export const resetPasswordSchema = z.object({ token: z.string().min(32).max(256), password });

const avatarKey = z.string().regex(
  /^(woman|man|neutral|amara|arjun|mei|leo|zoya|noor|sam)-(violet|blue|rose|coral|mustard|mint|tangerine|crimson|turquoise|cream)-(navy|teal|plum|forest|denim|charcoal|indigo|sand|burgundy|cobalt)$/,
);

export const profileSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  profileImageUrl: z.string().url().max(2_048).nullable().optional(),
  avatarKey: avatarKey.optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  mainObjective: z.string().trim().max(500).nullable().optional(),
}).strict();

export const preferencesSchema = z.object({
  preferredDays: z.array(day).max(7).optional(),
  preferredTime: time.nullable().optional(),
  workingFrequency: z.number().int().min(1).max(21).optional(),
  personalConstraints: z.string().trim().max(1_000).nullable().optional(),
  progressStyle: z.enum(["GENTLE", "BALANCED", "DETAILED"]).optional(),
  weekStartsOn: z.number().int().min(0).max(6).optional(),
}).strict();

export const onboardingSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  profileImageUrl: z.string().url().max(2_048).nullable().optional(),
  mainObjective: z.string().trim().min(1).max(500),
  avatarKey,
  preferences: preferencesSchema,
  firstGoal: z.object({
    id: z.string().cuid(),
    title: z.string().trim().min(3).max(120),
    targetDate: date,
    frequency: frequency,
    preferredDays: z.array(day).min(1).max(7),
    preferredTime: time.nullable().optional(),
    weeklyTarget: z.number().int().min(1).max(21),
  }).strict(),
});

const voiceDay = z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
export const voiceQuestionField = z.enum(["objective", "targetDate", "preferredDays", "preferredTime", "progressStyle"]);
export const voiceAnswersSchema = z.object({
  name: z.string().trim().min(1).max(80).nullable().optional(),
  objective: z.string().trim().min(3).max(120).nullable().optional(),
  targetDate: z.string().date().nullable().optional(),
  preferredDays: z.array(voiceDay).min(1).max(7).nullable().optional(),
  preferredTime: z.union([time, z.literal("Flexible")]).nullable().optional(),
  workingFrequency: z.number().int().min(1).max(7).nullable().optional(),
  progressStyle: z.enum(["Gentle", "Balanced", "Detailed"]).nullable().optional(),
  constraints: z.string().trim().max(1_000).nullable().optional(),
}).strict();

export const voiceStartSchema = z.object({
  locale: z.string().trim().min(2).max(35).default("en-IN"),
  name: z.string().trim().min(1).max(80).optional(),
}).strict();

export const voiceTurnSchema = z.object({
  audioBase64: z.string().min(128).max(1_200_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  mimeType: z.literal("audio/wav"),
  answers: voiceAnswersSchema.default({}),
  skippedFields: z.array(voiceQuestionField).max(5).default([]),
}).strict();

export const voiceSkipSchema = z.object({
  answers: voiceAnswersSchema.default({}),
  skippedFields: z.array(voiceQuestionField).max(5),
  languageCode: z.string().trim().min(2).max(35).default("en-IN"),
}).strict();

const goalFields = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).nullable().optional(),
  whyItMatters: z.string().trim().max(1_000).nullable().optional(),
  category: z.enum(["HEALTH", "LEARNING", "CAREER", "PERSONAL", "FINANCE", "RELATIONSHIPS", "PRODUCTIVITY", "CUSTOM"]),
  customCategory: z.string().trim().max(60).nullable().optional(),
  priority: priority.default("MEDIUM"),
  status: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"]).default("ACTIVE"),
  startDate: date,
  targetDate: z.union([z.null(), date]).optional(),
  frequency: frequency.default("WEEKLY"),
  preferredDays: z.array(day).max(7).default([]),
  preferredTime: time.nullable().optional(),
  weeklyTarget: z.number().int().min(1).max(21).default(3),
  metricUnit: z.string().trim().min(1).max(30).nullable().optional(),
  metricTarget: z.number().positive().max(1_000_000_000_000).nullable().optional(),
  metricCurrent: z.number().min(0).max(1_000_000_000_000).default(0),
  remindersEnabled: z.boolean().default(true),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  icon: z.string().trim().max(40).nullable().optional(),
});


export const updateGoalSchema = goalFields.partial().strict();

export const goalListQuery = pagination.extend({
  status: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"]).optional(),
  category: z.enum(["HEALTH", "LEARNING", "CAREER", "PERSONAL", "FINANCE", "RELATIONSHIPS", "PRODUCTIVITY", "CUSTOM"]).optional(),
});

const milestoneFields = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).nullable().optional(),
  targetDate: z.union([z.null(), date]).optional(),
  status: z.enum(["UPCOMING", "IN_PROGRESS", "COMPLETED"]).default("UPCOMING"),
  position: z.number().int().min(0).optional(),
});
export const createMilestoneSchema = milestoneFields.extend({ id: z.string().cuid().optional() });
export const updateMilestoneSchema = milestoneFields.partial().strict();

const actionFields = z.object({
  goalId: z.string().cuid(),
  milestoneId: z.string().cuid().nullable().optional(),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000).nullable().optional(),
  status: z.enum(["UPCOMING", "IN_PROGRESS", "COMPLETED", "MISSED", "SKIPPED"]).default("UPCOMING"),
  priority: priority.default("MEDIUM"),
  scheduledFor: optionalNullableDate,
  dueDate: optionalNullableDate,
  preferredTime: time.nullable().optional(),
  estimatedMinutes: z.number().int().min(1).max(1_440).nullable().optional(),
  difficulty: z.number().int().min(1).max(5).default(2),
  frequency: frequency.default("ONCE"),
  reminderEnabled: z.boolean().default(true),
});
export const createActionSchema = actionFields.extend({ id: z.string().cuid().optional() });
export const updateActionSchema = actionFields.omit({ goalId: true }).partial().strict();
export const actionListQuery = pagination.extend({
  goalId: z.string().cuid().optional(),
  status: z.enum(["UPCOMING", "IN_PROGRESS", "COMPLETED", "MISSED", "SKIPPED"]).optional(),
  from: date.optional(),
  to: date.optional(),
});

const routineFields = z.object({
  goalId: z.string().cuid(),
  name: z.string().trim().max(80).nullable().optional(),
  frequency,
  days: z.array(day).max(7).default([]),
  preferredTime: time.nullable().optional(),
  durationMinutes: z.number().int().min(1).max(1_440).nullable().optional(),
  timesPerWeek: z.number().int().min(1).max(21).nullable().optional(),
  isActive: z.boolean().default(true),
});
export const createRoutineSchema = routineFields;
export const updateRoutineSchema = routineFields.omit({ goalId: true }).partial().strict();
export const routineListQuery = z.object({ goalId: z.string().cuid().optional(), active: z.coerce.boolean().optional() });

const createPlanSchema = z.object({
  milestones: z.array(milestoneFields.pick({ title: true, description: true, targetDate: true }).extend({ id: z.string().cuid().optional() }).strict()).max(20).optional(),
  actions: z.array(actionFields.omit({ goalId: true, status: true }).extend({ id: z.string().cuid().optional() }).strict()).max(100).optional(),
  routine: routineFields.omit({ goalId: true, isActive: true }).partial().strict().optional(),
}).strict().superRefine((value, context) => {
  const milestoneIds = new Set(value.milestones?.map((milestone) => milestone.id).filter(Boolean));
  value.actions?.forEach((action, index) => {
    if (action.milestoneId && !milestoneIds.has(action.milestoneId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["actions", index, "milestoneId"], message: "Action milestone must be created in the same plan." });
    }
  });
});

export const createGoalSchema = goalFields.extend({ id: z.string().cuid().optional(), generatePlan: z.boolean().default(true), plan: createPlanSchema.optional() }).superRefine((value, context) => {
  if (value.category === "CUSTOM" && !value.customCategory) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["customCategory"], message: "Custom category is required." });
  }
  if (value.targetDate && value.targetDate < value.startDate) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetDate"], message: "Target date must be on or after the start date." });
  }
  if ((value.metricUnit == null) !== (value.metricTarget == null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["metricTarget"], message: "Metric unit and target must be supplied together." });
  }
  if (value.metricTarget == null && value.metricCurrent > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["metricCurrent"], message: "Metric progress requires a metric target." });
  }
});

export const logGoalProgressSchema = z.object({
  value: z.number().positive().max(1_000_000_000_000),
  note: z.string().trim().max(500).nullable().optional(),
}).strict();

const reflectionFields = z.object({
  periodStart: date,
  periodEnd: date,
  whatWentWell: z.string().trim().max(2_000).nullable().optional(),
  whatWasDifficult: z.string().trim().max(2_000).nullable().optional(),
  nextFocus: z.string().trim().max(2_000).nullable().optional(),
  mood: z.number().int().min(1).max(5).nullable().optional(),
});
export const createReflectionSchema = reflectionFields.extend({ id: z.string().cuid().optional() }).refine((value) => value.periodEnd >= value.periodStart, {
  message: "Period end must be on or after period start.",
  path: ["periodEnd"],
});
export const updateReflectionSchema = reflectionFields.partial().strict();
export const reflectionListQuery = pagination;

export const notificationPreferenceSchema = z.object({
  actionReminders: z.boolean().optional(),
  dueActionReminders: z.boolean().optional(),
  milestoneReminders: z.boolean().optional(),
  progressSummaries: z.boolean().optional(),
  weeklyReflection: z.boolean().optional(),
  quietHoursStart: time.nullable().optional(),
  quietHoursEnd: time.nullable().optional(),
  reminderMinutesBefore: z.number().int().min(0).max(10_080).optional(),
  pushEnabled: z.boolean().optional(),
}).strict();

export const notificationListQuery = pagination.extend({ unreadOnly: z.coerce.boolean().default(false) });
export const pushDeviceSchema = z.object({
  token: z.string().trim().min(20).max(4_096),
  platform: z.enum(["android", "ios", "web"]),
  deviceName: z.string().trim().max(120).nullable().optional(),
}).strict();
export const pushTokenSchema = z.object({ token: z.string().trim().min(20).max(4_096) }).strict();
export const scheduleQuery = z.object({ from: date, to: date }).refine(
  (value) => value.to >= value.from && value.to.getTime() - value.from.getTime() <= 93 * 86_400_000,
  { message: "Date range must be valid and no longer than 93 days.", path: ["to"] },
);

export const progressHistoryQuery = z.object({
  from: date.optional(),
  to: date.optional(),
}).refine(
  (value) => !value.from || !value.to || (value.to >= value.from && value.to.getTime() - value.from.getTime() <= 370 * 86_400_000),
  { message: "Date range must be valid and no longer than 370 days.", path: ["to"] },
);
