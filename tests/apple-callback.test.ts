import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const identityToken = "apple.identity.token".padEnd(140, "x");

describe("Apple Android callback", () => {
  let app: Server;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/set_a_goal";
    process.env.JWT_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
    process.env.APPLE_ANDROID_PACKAGE = "com.intentional.onward";
    ({ prisma } = await import("../src/db.js"));
    app = (await import("../src/app.js")).app.listen();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
  });

  it("returns a fixed intent while safely encoding Apple's success fields", async () => {
    const values = {
      code: "code+/=#Intent;package=evil.app;end",
      id_token: identityToken,
      state: "state with spaces & punctuation",
      user: JSON.stringify({ name: { firstName: "A&B" }, email: "person@example.com" }),
    };
    const response = await request(app)
      .post("/api/v1/auth/apple/callback")
      .type("form")
      .send(values)
      .redirects(0)
      .expect(303);

    const location = response.headers.location as string;
    const [intentUrl, intentTarget] = location.split("#Intent;");
    const returned = new URLSearchParams(intentUrl?.split("?")[1]);
    expect(Object.fromEntries(returned)).toEqual(values);
    expect(intentTarget).toBe("package=com.intentional.onward;scheme=signinwithapple;end");
    expect(location.match(/#Intent;/g)).toHaveLength(1);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers).toHaveProperty("ratelimit-policy");
  });

  it("returns Apple cancellation errors to the same fixed app target", async () => {
    const response = await request(app).post("/api/v1/auth/apple/callback").type("form").send({
      error: "user_cancelled_authorize",
      error_description: "The person cancelled.",
      state: "original-state",
    }).redirects(0).expect(303);
    expect(response.headers.location).toContain("error=user_cancelled_authorize");
    expect((response.headers.location as string).endsWith("#Intent;package=com.intentional.onward;scheme=signinwithapple;end")).toBe(true);
  });

  it("rejects JSON, unknown fields, missing state, and oversized fields", async () => {
    const valid = { code: "apple-code", id_token: identityToken, state: "original-state" };
    const json = await request(app).post("/api/v1/auth/apple/callback").send(valid).expect(415);
    expect(json.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");

    const unknown = await request(app).post("/api/v1/auth/apple/callback").type("form").send({ ...valid, package: "evil.app" }).expect(422);
    expect(unknown.body.error.code).toBe("VALIDATION_ERROR");

    await request(app).post("/api/v1/auth/apple/callback").type("form").send({ code: valid.code, id_token: identityToken }).expect(422);
    await request(app).post("/api/v1/auth/apple/callback").type("form").send({ ...valid, code: "x".repeat(4_097) }).expect(422);

    const tooLarge = await request(app).post("/api/v1/auth/apple/callback").type("form").send({ ...valid, user: "x".repeat(40_000) }).expect(413);
    expect(tooLarge.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});
