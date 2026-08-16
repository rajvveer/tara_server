import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { issueAccessToken } from "../src/auth.js";
import { isAllowedOrigin } from "../src/config.js";
import { attachRealtime } from "../src/realtime.js";

vi.mock("../src/sarvam.js", () => ({
  startVoiceOnboarding: vi.fn(async () => ({
    reply: "Hi Maya! I’m Tara. What goal would you love to make real?",
    languageCode: "en-IN",
    audioBase64: "UklGRg==",
    audioMimeType: "audio/wav",
  })),
  voiceOnboardingTurn: vi.fn(),
}));

const nextMessage = (socket: WebSocket) => new Promise<{ type: string; data: Record<string, unknown> }>((resolve) => {
  socket.once("message", (raw) => resolve(JSON.parse(raw.toString())));
});

describe("realtime transport", () => {
  const openSockets: WebSocket[] = [];
  const openServers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    openSockets.forEach((socket) => socket.terminate());
    await Promise.all(openServers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it("ships the upgrade handler and permits only configured or same-host origins", async () => {
    const { default: deployedServer } = await import("../src/app.js");
    expect(deployedServer.listenerCount("upgrade")).toBeGreaterThan(0);
    expect(isAllowedOrigin("https://api.example.com", "api.example.com")).toBe(true);
    expect(isAllowedOrigin("https://evil.example", "api.example.com")).toBe(false);
  });

  it("authenticates once and rejects unknown events without dropping the socket", async () => {
    const server = createServer();
    attachRealtime(server);
    openServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/realtime`);
    openSockets.push(socket);
    await new Promise<void>((resolve) => socket.once("open", resolve));

    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ type: "auth", data: { token: issueAccessToken("test-user") } }));
    await expect(ready).resolves.toMatchObject({ type: "ready" });

    const error = nextMessage(socket);
    socket.send(JSON.stringify({ type: "not-supported", data: {} }));
    await expect(error).resolves.toMatchObject({
      type: "error",
      data: { code: "UNKNOWN_EVENT" },
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("sends the voice opening as one playable reply", async () => {
    const server = createServer();
    attachRealtime(server);
    openServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/realtime`);
    openSockets.push(socket);
    await new Promise<void>((resolve) => socket.once("open", resolve));

    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ type: "auth", data: { token: issueAccessToken("test-user") } }));
    await expect(ready).resolves.toMatchObject({ type: "ready" });

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const response = new Promise<void>((resolve) => {
      socket.on("message", (raw) => {
        events.push(JSON.parse(raw.toString()));
        if (events.length === 2) resolve();
      });
    });
    socket.send(JSON.stringify({ type: "voice.start", data: { locale: "en-IN", name: "Maya" } }));
    await response;

    expect(events.map((event) => event.type)).toEqual(["voice.status", "voice.reply"]);
    expect(events[1]).toMatchObject({
      data: {
        reply: "Hi Maya! I’m Tara. What goal would you love to make real?",
        audioBase64: "UklGRg==",
        audioMimeType: "audio/wav",
        complete: false,
      },
    });
  });
});
