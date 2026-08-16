import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/errors.js";

const provider = vi.hoisted(() => ({ google: vi.fn(), apple: vi.fn() }));
vi.mock("../src/social-auth.js", () => ({
  verifyGoogleIdToken: provider.google,
  verifyAppleAuthorization: provider.apple,
}));

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const token = (label: string) => label.padEnd(120, "x");

run("social authentication (PostgreSQL)", () => {
  let app: Server;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const marker = randomUUID().slice(0, 8);
  const password = "StrongPassword123!";
  const gmail = `onward.social.${marker}@gmail.com`;
  const nonAuthoritativeEmail = `onward-social-${marker}@example.com`;
  const appleEmail = `apple-${marker}@privaterelay.appleid.com`;
  const secondEmail = `second.social.${marker}@gmail.com`;
  const createdEmails = [gmail, nonAuthoritativeEmail, appleEmail, secondEmail];
  let googleUserId = "";

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = databaseUrl!;
    process.env.JWT_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
    ({ prisma } = await import("../src/db.js"));
    app = (await import("../src/app.js")).app.listen();
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
      await prisma.$disconnect();
    }
    if (app) await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
  });

  it("rejects invalid provider tokens", async () => {
    provider.google.mockRejectedValueOnce(new ApiError(401, "INVALID_PROVIDER_TOKEN", "Invalid provider token."));
    const response = await request(app).post("/api/v1/auth/google").send({ idToken: token("invalid"), timezone: "UTC" }).expect(401);
    expect(response.body.error.code).toBe("INVALID_PROVIDER_TOKEN");
  });

  it("links an authoritative Gmail identity to the matching password account", async () => {
    const registered = await request(app).post("/api/v1/auth/register").send({ name: "Google Link", email: gmail, password, timezone: "UTC" }).expect(201);
    provider.google.mockResolvedValueOnce({
      provider: "google",
      subject: `google-${marker}`,
      email: gmail,
      suggestedName: "Ignored replacement",
      canAutoLinkEmail: true,
    });
    const signedIn = await request(app).post("/api/v1/auth/google").send({ idToken: token("google-link"), timezone: "UTC" }).expect(200);
    googleUserId = signedIn.body.data.user.id;
    expect(googleUserId).toBe(registered.body.data.user.id);
    expect(signedIn.body.data).toMatchObject({ tokenType: "Bearer", user: { email: gmail, name: "Google Link" } });
    expect(signedIn.body.data.refreshToken).toEqual(expect.any(String));
    await expect(prisma.user.findUniqueOrThrow({ where: { id: googleUserId } })).resolves.toMatchObject({ googleSubject: `google-${marker}` });
  });

  it("requires authenticated linking for a non-authoritative Google email", async () => {
    await request(app).post("/api/v1/auth/register").send({ name: "Existing User", email: nonAuthoritativeEmail, password, timezone: "UTC" }).expect(201);
    provider.google.mockResolvedValueOnce({
      provider: "google",
      subject: `untrusted-google-${marker}`,
      email: nonAuthoritativeEmail,
      canAutoLinkEmail: false,
    });
    const response = await request(app).post("/api/v1/auth/google").send({ idToken: token("non-authoritative"), timezone: "UTC" }).expect(409);
    expect(response.body.error.code).toBe("ACCOUNT_LINK_REQUIRED");
    await expect(prisma.user.findUniqueOrThrow({ where: { email: nonAuthoritativeEmail } })).resolves.toMatchObject({ googleSubject: null });
  });

  it("links an existing email only when Apple verifies it", async () => {
    const existing = await prisma.user.findUniqueOrThrow({ where: { email: nonAuthoritativeEmail } });
    provider.apple.mockResolvedValueOnce({
      provider: "apple",
      subject: `apple-link-${marker}`,
      email: nonAuthoritativeEmail,
      canAutoLinkEmail: true,
    });
    const linked = await request(app).post("/api/v1/auth/apple").send({
      authorizationCode: "link-code",
      identityToken: token("apple-link"),
      timezone: "UTC",
      platform: "ios",
    }).expect(200);
    expect(linked.body.data.user.id).toBe(existing.id);
    await expect(prisma.user.findUniqueOrThrow({ where: { id: existing.id } })).resolves.toMatchObject({ appleSubject: `apple-link-${marker}` });
  });

  it("creates an Apple account and returns it when later tokens omit name and email", async () => {
    provider.apple.mockResolvedValueOnce({
      provider: "apple",
      subject: `apple-${marker}`,
      email: appleEmail,
      suggestedName: "Private Person",
      canAutoLinkEmail: true,
    });
    const first = await request(app).post("/api/v1/auth/apple").send({
      authorizationCode: "first-code",
      identityToken: token("apple-first"),
      givenName: "Private",
      familyName: "Person",
      timezone: "Asia/Kolkata",
      platform: "ios",
    }).expect(200);

    provider.apple.mockResolvedValueOnce({
      provider: "apple",
      subject: `apple-${marker}`,
      canAutoLinkEmail: false,
    });
    const returning = await request(app).post("/api/v1/auth/apple").send({
      authorizationCode: "return-code",
      identityToken: token("apple-return"),
      timezone: "UTC",
      platform: "ios",
    }).expect(200);

    expect(returning.body.data.user.id).toBe(first.body.data.user.id);
    expect(returning.body.data.user).toMatchObject({ email: appleEmail, name: "Private Person", timezone: "Asia/Kolkata" });
    await expect(prisma.user.findUniqueOrThrow({ where: { id: first.body.data.user.id } })).resolves.toMatchObject({
      appleSubject: `apple-${marker}`,
      passwordHash: null,
    });
  });

  it("never moves an existing subject to a different user or replaces another subject", async () => {
    await request(app).post("/api/v1/auth/register").send({ name: "Second User", email: secondEmail, password, timezone: "UTC" }).expect(201);
    provider.google.mockResolvedValueOnce({
      provider: "google",
      subject: `google-${marker}`,
      email: secondEmail,
      canAutoLinkEmail: true,
    });
    const existingSubject = await request(app).post("/api/v1/auth/google").send({ idToken: token("same-subject"), timezone: "UTC" }).expect(200);
    expect(existingSubject.body.data.user.id).toBe(googleUserId);

    provider.google.mockResolvedValueOnce({
      provider: "google",
      subject: `different-google-${marker}`,
      email: gmail,
      canAutoLinkEmail: true,
    });
    const collision = await request(app).post("/api/v1/auth/google").send({ idToken: token("different-subject"), timezone: "UTC" }).expect(409);
    expect(collision.body.error.code).toBe("PROVIDER_ALREADY_LINKED");
    await expect(prisma.user.findUniqueOrThrow({ where: { email: gmail } })).resolves.toMatchObject({
      id: googleUserId,
      googleSubject: `google-${marker}`,
    });
  });
});
