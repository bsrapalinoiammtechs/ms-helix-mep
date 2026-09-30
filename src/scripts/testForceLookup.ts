import "dotenv/config";
import "../workers/meraki.worker";
import { lookupAlerts } from "../services/alertLookup.service";
import { closeMerakiQueue } from "../queues/meraki.queue";

/**
 * Prueba interna puntual, NO parte del flujo normal -- valida en real, contra
 * Meraki, cómo responde ahora mismo el lookup individual (la pieza nueva
 * usada por ReconciliationService.forceResolveStuckAlertsByIdLookup) para un
 * conjunto de alertIds reales que sabemos, por el dump de ms-helix-tcp
 * (alertas_enviadas_a_helix.txt, 30-sep-2026), que llevan semanas atascadas
 * como "activas" en Helix.
 *
 * Uso: npm run build && node build/scripts/testForceLookup.js
 * Requiere: Redis local corriendo (docker compose up -d redis-helix) -- NO
 * requiere Mongo, esto prueba solo la capa de consulta a Meraki.
 */

const ORG_ID = process.env.ORGANIZATION_ID || "";

const knownStuck = [
  { alertId: "3865777330156230777", nombreEquipo: "SAMEP-01APT010LI3636", fecha: "04-09-2026" },
  { alertId: "3865777330156230941", nombreEquipo: "SAMEP-01APT009LI3636", fecha: "04-09-2026" },
  { alertId: "3865777330156231070", nombreEquipo: "SAMEP-01APT001CA1957", fecha: "04-09-2026" },
  { alertId: "3865777330156274995", nombreEquipo: "SAMEP-01APT018SJ4188", fecha: "08-09-2026" },
  { alertId: "3865777330156319255", nombreEquipo: "SAMEP-01APT005PU3754", fecha: "11-09-2026" },
  { alertId: "3865777330156415047", nombreEquipo: "SAMEP-01APT010SJ6530", fecha: "17-09-2026" },
  { alertId: "3865777330156475307", nombreEquipo: "SAMEP-01APT004GU2643", fecha: "22-09-2026" },
  { alertId: "3865777330156505068", nombreEquipo: "SAMEP-01APT002LI4141", fecha: "23-09-2026" },
];

async function main() {
  console.log("=== Prueba interna: lookup individual contra Meraki (real) ===");
  console.log(`organizationId=${ORG_ID}`);
  console.log(`Consultando ${knownStuck.length} alertIds reales, conocidos como atascados en Helix.\n`);

  if (!ORG_ID || !process.env.TOKEN_CISCO) {
    console.error("Falta ORGANIZATION_ID o TOKEN_CISCO en .env");
    process.exit(1);
  }

  const results = await lookupAlerts(ORG_ID, knownStuck.map((a) => a.alertId));

  console.log("--- Resultado por alerta ---");
  for (const known of knownStuck) {
    const r = results.find((x) => x.alertId === known.alertId);
    console.log(
      `${known.alertId} (${known.nombreEquipo}, atascada desde ${known.fecha}) -> ${r?.estado ?? "SIN_RESULTADO"}` +
        (r?.resolvedAt ? ` (resolvedAt real: ${r.resolvedAt})` : "") +
        (r?.dismissedAt ? ` (dismissedAt: ${r.dismissedAt})` : "") +
        (r?.error ? ` (error: ${r.error})` : ""),
    );
  }

  const counts = {
    ACTIVA: results.filter((r) => r.estado === "ACTIVA").length,
    CESADA: results.filter((r) => r.estado === "CESADA").length,
    NO_ENCONTRADA: results.filter((r) => r.estado === "NO_ENCONTRADA").length,
    ERROR: results.filter((r) => r.estado === "ERROR").length,
  };
  console.log("\n--- Resumen ---");
  console.log(counts);
  console.log(
    "\nInterpretación: ACTIVA o CESADA confirma qué haría forceResolveStuckAlertsByIdLookup() con cada una" +
      " (dejarla igual, o resolverla con la fecha real). NO_ENCONTRADA es el caso 404 -- se resolvería" +
      ' con la fecha de detección y resolvedVia:"reconciliation:force_not_found:*".',
  );

  await closeMerakiQueue();
  process.exit(0);
}

main().catch((err) => {
  console.error("test.fatal_error", err);
  process.exit(1);
});
