import type { Prisma } from "@prisma/client";
import { prisma } from "./db.js";

export async function track(userId: string | null, name: string, properties?: Prisma.InputJsonValue) {
  await prisma.analyticsEvent.create({ data: { userId, name, properties } });
}
