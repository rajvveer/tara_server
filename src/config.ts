import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  DATABASE_URL: z.string().url().or(z.string().startsWith("postgresql://")),
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default("onward-api"),
  JWT_AUDIENCE: z.string().default("onward-app"),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  CORS_ORIGINS: z.string().default("http://localhost:3000,http://localhost:5173"),
  GOOGLE_CLIENT_IDS: z.string().default(""),
  APP_URL: z.union([z.literal(""), z.string().url()]).default(""),
  RESEND_API_KEY: z.string().default(""),
  RESET_FROM_EMAIL: z.string().default(""),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().default(""),
  FIREBASE_SERVICE_ACCOUNT_FILE: z.string().default(""),
  CRON_SECRET: z.union([z.literal(""), z.string().min(16)]).default(""),
  SARVAM_API_KEY: z.string().default(""),
  GROQ_API_KEY: z.string().default(""),
  APPLE_BUNDLE_ID: z.string().default(""),
  APPLE_SERVICE_ID: z.string().default(""),
  APPLE_TEAM_ID: z.string().default(""),
  APPLE_KEY_ID: z.string().default(""),
  APPLE_PRIVATE_KEY: z.string().default(""),
  APPLE_REDIRECT_URI: z.union([z.literal(""), z.string().url()]).default(""),
  APPLE_ANDROID_PACKAGE: z.string().max(255).regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/).default("com.intentional.onward"),
}).superRefine((value, context) => {
  if (value.NODE_ENV !== "production") return;
  for (const field of ["APP_URL", "RESEND_API_KEY", "RESET_FROM_EMAIL", "SARVAM_API_KEY", "GROQ_API_KEY"] as const) {
    if (!value[field]) context.addIssue({ code: "custom", path: [field], message: "Required in production" });
  }
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", ")}`);
}

export const config = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
  googleClientIds: parsed.data.GOOGLE_CLIENT_IDS.split(",").map((id) => id.trim()).filter(Boolean),
};

export function isAllowedOrigin(origin?: string, host?: string) {
  if (!origin || config.corsOrigins.includes("*") || config.corsOrigins.includes(origin)) return true;
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}
