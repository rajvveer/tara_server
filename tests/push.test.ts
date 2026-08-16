import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { dispatchDueNotifications } from "../src/push.js";

const originalJson = config.FIREBASE_SERVICE_ACCOUNT_JSON;
const originalFile = config.FIREBASE_SERVICE_ACCOUNT_FILE;

afterEach(() => {
  config.FIREBASE_SERVICE_ACCOUNT_JSON = originalJson;
  config.FIREBASE_SERVICE_ACCOUNT_FILE = originalFile;
  vi.restoreAllMocks();
});

describe("push configuration", () => {
  it("does not fail maintenance when an optional credential file is absent", async () => {
    config.FIREBASE_SERVICE_ACCOUNT_JSON = "";
    config.FIREBASE_SERVICE_ACCOUNT_FILE = "Z:\\missing\\firebase-service-account.json";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(dispatchDueNotifications()).resolves.toBe(0);
  });
});
