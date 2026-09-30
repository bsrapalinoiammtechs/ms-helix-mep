import "dotenv/config";
import mongoose from "mongoose";
import Alert from "../models/Alert";
import { cleanupStaleNetworkAlerts } from "../services/staleAlertCleanup.service";

/**
 * Prueba interna puntual, NO parte del flujo normal -- valida la lógica de
 * cleanupStaleNetworkAlerts con datos sintéticos que replican el caso real
 * de Cariari (30-sep-2026): un equipo viejo en una red "SAMEP-PRUEBAS-RMA"
 * (debe cerrarse) y uno de control en una red real (NO debe tocarse).
 *
 * Uso: npm run build && node build/scripts/testStaleCleanup.js
 * Conecta a Mongo vía MONGO_DB del .env -- si corres esto fuera de Docker,
 * exporta MONGO_DB apuntando a localhost:<MONGO_LOCAL_PORT> antes de correr.
 */

const TEST_ALERT_RMA = "test-stale-cleanup-rma-001";
const TEST_ALERT_REAL = "test-stale-cleanup-real-001";

const baseFields = {
  organization: { id: "846353", name: "Ministerio de Educación Pública- Costa Rica" },
  categoryType: "network",
  deviceType: "wireless",
  type: "unreachable",
  title: "Unreachable device",
  severity: "info",
  scope: { devices: [{ url: "https://dashboard.meraki.com/x", productType: "wireless", name: "test" }] },
  isGlpi: true,
  isTcp: false,
};

async function main() {
  await mongoose.connect(process.env.MONGO_DB || "");
  console.log("Conectado a Mongo.");

  const oldStartedAt = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(); // 10 días atrás

  await Alert.findOneAndUpdate(
    { alertId: TEST_ALERT_RMA },
    {
      $set: {
        ...baseFields,
        alertId: TEST_ALERT_RMA,
        network: { id: "L_test_rma", name: "SAMEP-PRUEBAS-RMA" },
        startedAt: oldStartedAt,
        resolvedAt: null,
      },
    },
    { upsert: true },
  );

  await Alert.findOneAndUpdate(
    { alertId: TEST_ALERT_REAL },
    {
      $set: {
        ...baseFields,
        alertId: TEST_ALERT_REAL,
        network: { id: "L_test_real", name: "104187-00 - SAMEP01 - Liceo de Cariari 4141_LI07" },
        startedAt: oldStartedAt,
        resolvedAt: null,
      },
    },
    { upsert: true },
  );

  console.log("Datos sintéticos insertados:");
  console.log(`  ${TEST_ALERT_RMA} -> red "SAMEP-PRUEBAS-RMA" (debe cerrarse)`);
  console.log(`  ${TEST_ALERT_REAL} -> red real de Cariari (NO debe tocarse)\n`);

  const summary = await cleanupStaleNetworkAlerts();
  console.log("--- Resumen ---");
  console.log(summary);

  const rmaAfter = await Alert.findOne({ alertId: TEST_ALERT_RMA }).lean();
  const realAfter = await Alert.findOne({ alertId: TEST_ALERT_REAL }).lean();

  console.log("\n--- Verificación ---");
  console.log(
    `${TEST_ALERT_RMA}: resolvedAt=${(rmaAfter as any)?.resolvedAt} resolvedVia=${(rmaAfter as any)?.resolvedVia} ` +
      ((rmaAfter as any)?.resolvedAt ? "-> OK, se cerró" : "-> FALLO, debería haberse cerrado"),
  );
  console.log(
    `${TEST_ALERT_REAL}: resolvedAt=${(realAfter as any)?.resolvedAt} ` +
      ((realAfter as any)?.resolvedAt ? "-> FALLO, no debía tocarse" : "-> OK, quedó intacta"),
  );

  await Alert.deleteMany({ alertId: { $in: [TEST_ALERT_RMA, TEST_ALERT_REAL] } });
  console.log("\nDatos sintéticos de prueba eliminados.");

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("test.fatal_error", err);
  process.exit(1);
});
