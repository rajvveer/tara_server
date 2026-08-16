import { realtime, server } from "./app.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { runMaintenance } from "./maintenance.js";

server.listen(config.PORT, () => {
  console.log(JSON.stringify({ level: "info", message: "GoalSpring API listening", port: config.PORT, environment: config.NODE_ENV }));
});

let maintenanceRunning = false;
async function maintain() {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  try {
    const result = await runMaintenance();
    console.log(JSON.stringify({ level: "info", message: "Maintenance complete", ...result }));
  } catch (error) {
    console.error(JSON.stringify({ level: "error", message: "Maintenance failed", error: error instanceof Error ? error.message : String(error) }));
  } finally {
    maintenanceRunning = false;
  }
}
void maintain();
const maintenanceTimer = setInterval(() => void maintain(), 5 * 60_000);
maintenanceTimer.unref();

async function shutdown(signal: string) {
  console.log(JSON.stringify({ level: "info", message: "Shutting down", signal }));
  clearInterval(maintenanceTimer);
  realtime.clients.forEach((socket) => socket.close(1001, "Server shutting down"));
  realtime.close();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
