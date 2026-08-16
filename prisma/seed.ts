import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const email = "demo@onward.app";
const password = "OnwardDemo123!";

async function main() {
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash },
    create: {
      name: "Maya",
      email,
      passwordHash,
      timezone: "Asia/Kolkata",
      mainObjective: "Make steady progress on the things that matter most",
      onboardingCompleted: true,
      preferences: { create: { preferredDays: ["MONDAY", "WEDNESDAY", "FRIDAY", "SUNDAY"], preferredTime: "19:00", workingFrequency: 4, progressStyle: "BALANCED" } },
      notificationPrefs: { create: { quietHoursStart: "22:00", quietHoursEnd: "07:00" } },
    },
  });

  if (await prisma.goal.count({ where: { userId: user.id, deletedAt: null } })) return;

  const start = new Date();
  start.setDate(start.getDate() - 21);
  const target = new Date(start);
  target.setMonth(target.getMonth() + 3);
  const goal = await prisma.goal.create({
    data: {
      userId: user.id,
      title: "Build a stronger, more energetic body",
      description: "A realistic routine built around strength, walking, and recovery.",
      whyItMatters: "I want everyday energy and confidence, not a short-term transformation.",
      category: "HEALTH",
      priority: "HIGH",
      startDate: start,
      targetDate: target,
      frequency: "WEEKLY",
      weeklyTarget: 4,
      preferredDays: ["MONDAY", "WEDNESDAY", "FRIDAY", "SUNDAY"],
      preferredTime: "19:00",
      color: "#68745B",
      icon: "activity",
      routines: { create: { userId: user.id, name: "Evening movement", frequency: "WEEKLY", days: ["MONDAY", "WEDNESDAY", "FRIDAY", "SUNDAY"], preferredTime: "19:00", durationMinutes: 45, timesPerWeek: 4 } },
    },
  });

  const milestone = await prisma.milestone.create({ data: { userId: user.id, goalId: goal.id, title: "Establish a repeatable 4-week rhythm", status: "IN_PROGRESS", position: 0, targetDate: new Date(Date.now() + 14 * 86_400_000) } });
  const today = new Date();
  today.setHours(18, 30, 0, 0);
  const twoDaysAgo = new Date(today);
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const completed = await prisma.action.create({ data: { userId: user.id, goalId: goal.id, milestoneId: milestone.id, title: "Full-body strength session", status: "COMPLETED", scheduledFor: twoDaysAgo, completedAt: twoDaysAgo, preferredTime: "19:00", estimatedMinutes: 45, difficulty: 3 } });
  await prisma.action.createMany({ data: [
    { userId: user.id, goalId: goal.id, milestoneId: milestone.id, title: "30-minute recovery walk", status: "UPCOMING", scheduledFor: today, preferredTime: "18:30", estimatedMinutes: 30, difficulty: 1 },
    { userId: user.id, goalId: goal.id, milestoneId: milestone.id, title: "Strength session · lower body", status: "UPCOMING", scheduledFor: tomorrow, preferredTime: "19:00", estimatedMinutes: 45, difficulty: 3 },
  ] });
  await prisma.progressRecord.create({ data: { userId: user.id, goalId: goal.id, actionId: completed.id, status: "COMPLETED", occurredAt: twoDaysAgo } });
  await prisma.notification.create({ data: { userId: user.id, type: "ACTION_REMINDER", title: "A gentle nudge", body: "Your recovery walk is planned for this evening.", scheduledAt: today } });
}

main()
  .then(() => console.log(`Demo ready: ${email} / ${password}`))
  .finally(() => prisma.$disconnect());
