import { beforeAll, describe, expect, it } from "vitest";

describe("provider token verification", () => {
  let verifyGoogleIdToken: (token: string) => Promise<unknown>;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/set_a_goal";
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret-that-is-at-least-thirty-two-characters";
    process.env.GOOGLE_CLIENT_IDS = "onward-test.apps.googleusercontent.com";
    ({ verifyGoogleIdToken } = await import("../src/social-auth.js"));
  });

  it("rejects a malformed Google token without a development bypass", async () => {
    await expect(verifyGoogleIdToken("not-a-signed-google-token")).rejects.toMatchObject({
      status: 401,
      code: "INVALID_PROVIDER_TOKEN",
    });
  });
});
