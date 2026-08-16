import type { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { ApiError } from "./errors.js";

export async function ownedAction(userId: string, id: string) {
  const action = await prisma.action.findFirst({
    where: { id, userId, deletedAt: null, goal: { deletedAt: null } },
  });
  if (!action) throw new ApiError(404, "ACTION_NOT_FOUND", "Action not found.");
  return action;
}

export async function syncMilestoneCompletion(
  transaction: Prisma.TransactionClient,
  milestoneId: string | null | undefined,
  occurredAt = new Date(),
) {
  if (!milestoneId) return;
  const [total, remaining] = await Promise.all([
    transaction.action.count({ where: { milestoneId, deletedAt: null } }),
    transaction.action.count({
      where: { milestoneId, deletedAt: null, status: { not: "COMPLETED" } },
    }),
  ]);
  if (total === 0) return;
  await transaction.milestone.updateMany({
    where: { id: milestoneId, deletedAt: null },
    data: remaining === 0
      ? { status: "COMPLETED", completedAt: occurredAt }
      : { status: "UPCOMING", completedAt: null },
  });
}

export async function transitionAction(
  userId: string,
  id: string,
  status: "UPCOMING" | "IN_PROGRESS" | "COMPLETED" | "MISSED" | "SKIPPED",
  patch: Prisma.ActionUpdateInput = {},
) {
  const current = await ownedAction(userId, id);
  const occurredAt = new Date();
  return prisma.$transaction(async (transaction) => {
    const action = await transaction.action.update({
      where: { id },
      data: {
        ...patch,
        status,
        completedAt: status === "COMPLETED"
          ? occurredAt
          : status === "UPCOMING" || status === "IN_PROGRESS"
            ? null
            : current.completedAt,
        skippedAt: status === "SKIPPED"
          ? occurredAt
          : status === "UPCOMING" || status === "IN_PROGRESS"
            ? null
            : current.skippedAt,
      },
      include: {
        goal: { select: { id: true, title: true, color: true, icon: true } },
        milestone: { select: { id: true, title: true } },
      },
    });

    if (current.status !== status) {
      await transaction.progressRecord.create({
        data: { userId, goalId: current.goalId, actionId: id, status, occurredAt },
      });
      await transaction.analyticsEvent.create({
        data: {
          userId,
          name: status === "COMPLETED"
            ? "action_completed"
            : status === "SKIPPED"
              ? "action_skipped"
              : "action_status_changed",
          properties: { actionId: id, goalId: current.goalId, status },
        },
      });
    }

    for (const milestoneId of new Set([current.milestoneId, action.milestoneId])) {
      await syncMilestoneCompletion(transaction, milestoneId, occurredAt);
    }
    return action;
  });
}
