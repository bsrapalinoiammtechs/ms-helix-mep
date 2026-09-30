import "dotenv/config";
import mongoose from "mongoose";
import "../workers/staleAlertCleanup.worker";
import Alert from "../models/Alert";
import { enqueueStaleAlertCleanupCycle, staleAlertCleanupQueue, staleAlertCleanupQueueEvents } from "../queues/staleAlertCleanup.queue";

/**
 * Prueba interna puntual -- confirma el camino completo cola -> worker ->
 * servicio (no solo la función suelta, como testStaleCleanup.ts).
 * Uso: npm run build && node build/scripts/testStaleCleanupQueue.js
 */

const TEST_ALERT_RMA = "test-stale-cleanup-queue-rma-001";

async function main() {
  await mongoose.connect(process.env.MONGO_DB || "");
  console.log("Conectado a Mongo.");

  const oldStartedAt = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();

  await Alert.findOneAndUpdate(
    { alertId: TEST_ALERT_RMA },
    {
      $set: {
        alertId: TEST_ALERT_RMA,
        organization: { id: "846353", name: "Ministerio de Educación Pública- Costa Rica" },
        categoryType: "network",
        network: { id: "L_test_rma_queue", name: "SAMEP-PRUEBAS-RMA" },
        deviceType: "wireless",
        type: "unreachable",
        title: "Unreachable device",
        severity: "info",
        scope: { devices: [{ url: "https://dashboard.meraki.com/x", productType: "wireless", name: "test" }] },
        isGlpi: true,
        isTcp: false,
        startedAt: oldStartedAt,
        resolvedAt: null,
      },
    },
    { upsert: true },
  );
  console.log(`Alerta sintética ${TEST_ALERT_RMA} insertada (red RMA).\n`);

  console.log("Encolando ciclo vía BullMQ (cola real, worker real)...");
  await enqueueStaleAlertCleanupCycle();
  console.log("Job terminó.\n");

  const after = await Alert.findOne({ alertId: TEST_ALERT_RMA }).lean();
  console.log(
    `${TEST_ALERT_RMA}: resolvedAt=${(after as any)?.resolvedAt} resolvedVia=${(after as any)?.resolvedVia} ` +
      ((after as any)?.resolvedAt ? "-> OK, la cola+worker+servicio funcionaron de punta a punta" : "-> FALLO"),
  );

  await Alert.deleteMany({ alertId: TEST_ALERT_RMA });
  await staleAlertCleanupQueueEvents.close();
  await staleAlertCleanupQueue.close();
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("test.fatal_error", err);
  process.exit(1);
});
