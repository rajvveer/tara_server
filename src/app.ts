import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import cors from "cors";
import helmetModule from "helmet";
import { rateLimit } from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import { config, isAllowedOrigin } from "./config.js";
import { prisma } from "./db.js";
import { ApiError, errorHandler, notFound } from "./errors.js";
import { openapi } from "./openapi.js";
import { attachRealtime } from "./realtime.js";
import router from "./routes.js";
import { runMaintenance } from "./maintenance.js";

const helmet = helmetModule as unknown as (options?: object) => express.RequestHandler;

export const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((request, response, next) => {
  request.id = request.get("x-request-id")?.slice(0, 100) ?? randomUUID();
  response.setHeader("x-request-id", request.id);
  next();
});
app.use(helmet({ contentSecurityPolicy: config.NODE_ENV === "production" ? undefined : false }));
app.use((request, response, next) => cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin, request.get("host"))) callback(null, true);
    else callback(new ApiError(403, "ORIGIN_NOT_ALLOWED", "This origin is not allowed."));
  },
  allowedHeaders: ["Authorization", "Content-Type", "X-Request-Id"],
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
})(request, response, next));
// Voice turns contain up to 25 seconds of base64 PCM audio. All other JSON stays small.
app.use("/api/v1/voice/onboarding/turn", express.json({ limit: "1400kb" }));
app.use(express.json({ limit: "100kb" }));

app.get("/health", async (_request, response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    response.json({ data: { status: "ok", database: "connected", timestamp: new Date().toISOString() } });
  } catch {
    response.status(503).json({ data: { status: "degraded", database: "unavailable", timestamp: new Date().toISOString() } });
  }
});
app.get("/api/maintenance", async (request, response) => {
  if (!config.CRON_SECRET || request.get("authorization") !== `Bearer ${config.CRON_SECRET}`) {
    response.status(401).json({ error: { code: "UNAUTHORIZED", message: "Unauthorized." } });
    return;
  }
  response.json({ data: await runMaintenance() });
});
app.get("/api/openapi.json", (_request, response) => response.json(openapi));
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: "GoalSpring API" }));

app.use("/api/v1/auth", rateLimit({ windowMs: 15 * 60_000, limit: 100, standardHeaders: "draft-8", legacyHeaders: false }));
app.use("/api/v1/voice", rateLimit({ windowMs: 60_000, limit: 15, standardHeaders: "draft-8", legacyHeaders: false }));
app.use("/api/v1", router);
app.use(notFound);
app.use(errorHandler);

export const server = createServer(app);
export const realtime = attachRealtime(server);

export default server;
