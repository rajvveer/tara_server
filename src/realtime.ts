import type { Server as HttpServer } from "node:http";
import { z, ZodError } from "zod";
import WebSocket, { WebSocketServer } from "ws";
import { verifyAccessToken } from "./auth.js";
import { chatTurnSchema, streamCoachReply } from "./chat.js";
import { isAllowedOrigin } from "./config.js";
import { ApiError } from "./errors.js";
import { skipVoiceOnboardingQuestion, startVoiceOnboarding, voiceOnboardingTurn } from "./sarvam.js";
import { voiceSkipSchema, voiceStartSchema, voiceTurnSchema } from "./schemas.js";

const envelopeSchema = z.object({
  type: z.string().trim().min(1).max(50),
  data: z.unknown().default({}),
}).strict();

const authSchema = z.object({ token: z.string().min(20).max(16_384) }).strict();

function send(socket: WebSocket, type: string, data: unknown = {}) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, data }));
}

function sendError(socket: WebSocket, error: unknown) {
  const apiError = error instanceof ApiError
    ? error
    : error instanceof ZodError
      ? new ApiError(422, "VALIDATION_ERROR", "Please check the submitted values.")
      : new ApiError(500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
  send(socket, "error", { code: apiError.code, message: apiError.message });
}

export function attachRealtime(server: HttpServer) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1_400_000 });

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const origin = request.headers.origin;
    if (pathname !== "/api/v1/realtime" || !isAllowedOrigin(origin, request.headers.host)) return socket.destroy();
    sockets.handleUpgrade(request, socket, head, (webSocket) => sockets.emit("connection", webSocket));
  });

  sockets.on("connection", (socket) => {
    let userId: string | null = null;
    let busy = false;
    let recentTurns: number[] = [];
    const authTimeout = setTimeout(() => socket.close(4401, "Authentication required"), 10_000);

    socket.on("error", () => undefined);
    socket.on("message", async (raw) => {
      try {
        const message = envelopeSchema.parse(JSON.parse(raw.toString()));
        if (!userId) {
          if (message.type !== "auth") throw new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue.");
          const { token } = authSchema.parse(message.data);
          userId = verifyAccessToken(token);
          clearTimeout(authTimeout);
          send(socket, "ready");
          return;
        }

        if (busy) throw new ApiError(409, "REALTIME_BUSY", "Please wait for the current reply.");
        const now = Date.now();
        recentTurns = recentTurns.filter((time) => now - time < 60_000);
        if (recentTurns.length >= 15) throw new ApiError(429, "RATE_LIMITED", "Please pause for a moment and try again.");

        busy = true;
        recentTurns.push(now);
        try {
          if (message.type === "voice.start") {
            send(socket, "voice.status", { stage: "preparing" });
            const input = voiceStartSchema.parse(message.data);
            const opening = await startVoiceOnboarding(input.locale, input.name);
            send(socket, "voice.reply", {
              ...opening,
              answers: {},
              questionField: "objective",
              complete: false,
            });
          } else if (message.type === "voice.turn") {
            send(socket, "voice.status", { stage: "transcribing" });
            const result = await voiceOnboardingTurn(voiceTurnSchema.parse(message.data), (event) => {
              if (event.type === "transcript") {
                send(socket, "voice.transcript", event);
                send(socket, "voice.status", { stage: "thinking" });
              } else {
                send(socket, "voice.status", { stage: "preparing_audio" });
              }
            });
            send(socket, "voice.reply", result);
          } else if (message.type === "voice.skip") {
            send(socket, "voice.status", { stage: "thinking" });
            send(socket, "voice.reply", await skipVoiceOnboardingQuestion(voiceSkipSchema.parse(message.data)));
          } else if (message.type === "chat.message") {
            const input = chatTurnSchema.parse(message.data);
            send(socket, "chat.start");
            await streamCoachReply(
              userId,
              input,
              (text) => send(socket, "chat.delta", { text }),
              () => send(socket, "chat.data_changed"),
            );
            send(socket, "chat.done");
          } else {
            throw new ApiError(422, "UNKNOWN_EVENT", "That realtime event is not supported.");
          }
        } finally {
          busy = false;
        }
      } catch (error) {
        if (!(error instanceof ApiError) && !(error instanceof ZodError)) {
          console.error(JSON.stringify({
            level: "error",
            message: "Realtime request failed",
            error: error instanceof Error ? error.message : String(error),
          }));
        }
        sendError(socket, error);
      }
    });
    socket.on("close", () => clearTimeout(authTimeout));
  });

  return sockets;
}
