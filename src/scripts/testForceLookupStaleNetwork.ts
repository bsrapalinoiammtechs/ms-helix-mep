import "dotenv/config";
import "../workers/meraki.worker";
import mongoose from "mongoose";
import Alert from "../models/Alert";
import ReconciliationService from "../services/reconciliation.service";
import { closeMerakiQueue } from "../queues/meraki.queue";

/**
 * Prueba interna puntual -- valida el fix del 30-sep-2026: una alerta
 * guardada localmente con su red REAL original, cuyo equipo Meraki ya
 * reporta en vivo dentro de una red de tránsito (RMA), debe cerrarse por
 * forceResolveStuckAlertsByIdLookup() aunque Meraki diga "ACTIVA".
 *
 * Caso real usado: alertId 3865777330156201286 (SAMEP-02APT044LI4227) --
 * guardado en Mongo con network.name="C.T.P. Pococí" (su red original),
 * pero Meraki ya lo reporta en vivo en la red "RMAs".
 *
 * Uso: npm run build && MONGO_DB=... node build/scripts/testForceLookupStaleNetwork.js
 */

const REAL_ALERT_ID = "3865777330156201286";

async function main() {
  await mongoose.connect(process.env.MONGO_DB || "");
  console.log("Conectado a Mongo.");

  const oldStartedAt = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();

  await Alert.findOneAndUpdate(
    { alertId: REAL_ALERT_ID },
    {
      $set: {
        alertId: REAL_ALERT_ID,
        organization: { id: "846353", name: "Ministerio de Educación Pública- Costa Rica" },
        categoryType: "network",
        network: { id: "L_test_pococi", name: "104266-00 - SAMEP01 - C.T.P Pococi 4227_LI07" },
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
  console.log(`Alerta sintética ${REAL_ALERT_ID} insertada con su red ORIGINAL (no RMA).\n`);

  const service = new ReconciliationService({
    dryRun: false,
    forceLookupStuckDays: 2,
    forceLookupMaxPerRun: 10,
    source: "test",
  });

  const result = await (service as any).forceResolveStuckAlertsByIdLookup();
  console.log("--- Resultado ---");
  console.log(result);

  const after = await Alert.findOne({ alertId: REAL_ALERT_ID }).lean();
  console.log("\n--- Verificación ---");
  console.log(
    `resolvedAt=${(after as any)?.resolvedAt} resolvedVia=${(after as any)?.resolvedVia} ` +
      ((after as any)?.resolvedVia === "reconciliation:force_lookup_stale_network:test"
        ? "-> OK, detectado y cerrado por red de tránsito en vivo"
        : "-> revisar"),
  );

  await Alert.deleteMany({ alertId: REAL_ALERT_ID });
  await closeMerakiQueue();
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("test.fatal_error", err);
  process.exit(1);
});
