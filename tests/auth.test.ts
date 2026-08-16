import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

vi.mock("../src/db.js", () => ({
  prisma: {
    user: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    session: { create: vi.fn(), findUnique: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

describe("password security", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hashes passwords without retaining plaintext", async () => {
    const plain = "StrongPassword123!";
    const hashed = await bcrypt.hash(plain, 12);
    expect(hashed).not.toContain(plain);
    await expect(bcrypt.compare(plain, hashed)).resolves.toBe(true);
  });
});
