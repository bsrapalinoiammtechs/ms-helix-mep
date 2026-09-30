import { Job } from "bullmq";
import Alert from "../models/Alert";
import { isStaleNetworkName, getStaleNetworkPatterns } from "../utils/staleNetwork";
import { log } from "../utils/logger";

/**
 * Limpieza de alertas huérfanas por reemplazo de hardware (RMA).
 *
 * Caso real encontrado (30-sep-2026, revisión manual con el usuario): un
 * equipo se reemplaza físicamente; el equipo VIEJO se mueve a una red de
 * "estacionamiento" (ej. `SAMEP-PRUEBAS-RMA`) mientras se gestiona su
 * devolución, y el equipo NUEVO se instala en la red real con el MISMO
 * nombre lógico (continuidad de monitoreo). Nadie cierra a mano la alerta
 * del equipo viejo -- y como sigue genuinamente fuera de línea (está
 * literalmente desconectado, parqueado), Meraki jamás la va a marcar
 * resuelta por sí solo: el lookup individual (alertLookup.service.ts /
 * ReconciliationService.forceResolveStuckAlertsByIdLookup) confirma
 * correctamente "sigue activa" para siempre, porque técnicamente es cierto
 * para ESE equipo. No es un bug de reconciliación -- es que la alerta ya no
 * representa un caso real para el NOC.
 *
 * Esta limpieza NO consulta a Meraki -- es puramente local, por eso puede
 * correr en su propio cron sin preocuparse del rate-limit. La señal es el
 * NOMBRE de la red: si contiene alguno de los patrones configurados (por
 * defecto "PRUEBAS"/"RMA", confirmado con el cliente como convención real
 * de nomenclatura para redes de tránsito, no escuelas reales) y la alerta
 * lleva más de `STALE_ALERT_CLEANUP_MIN_DAYS` sin resolver, se cierra con
 * un `resolvedVia` distinto para dejar clara la razón en Compras/auditoría.
 */

const MIN_STUCK_DAYS = parseInt(process.env.STALE_ALERT_CLEANUP_MIN_DAYS || "2", 10);

type CandidateAlert = {
  alertId: string;
  startedAt: string;
  network?: { id?: string; name?: string };
};

export type StaleAlertCleanupSummary = {
  candidates: number;
  matchedByNetworkPattern: number;
  resolved: number;
  errors: number;
  patterns: string[];
};

export async function cleanupStaleNetworkAlerts(job?: Job): Promise<StaleAlertCleanupSummary> {
  const cutoff = new Date(Date.now() - MIN_STUCK_DAYS * 24 * 3600 * 1000).toISOString();
  const patterns = getStaleNetworkPatterns();

  const candidates = await Alert.find({
    resolvedAt: null,
    isGlpi: true,
    startedAt: { $lt: cutoff },
  }).lean<CandidateAlert[]>();

  const matches = candidates.filter((a) => isStaleNetworkName(a.network?.name));

  log.info("stale_alert_cleanup.start", {
    total_candidates: candidates.length,
    matched_by_network_pattern: matches.length,
    patterns,
    min_stuck_days: MIN_STUCK_DAYS,
  });
  await job?.log(
    `Candidatas atascadas >${MIN_STUCK_DAYS}d: ${candidates.length}. ` +
      `De esas, en red de tránsito (${patterns.join("/")}): ${matches.length}.`,
  );

  let resolved = 0;
  let errors = 0;

  for (const alert of matches) {
    try {
      const updated = await Alert.findOneAndUpdate(
        { alertId: alert.alertId, resolvedAt: null },
        {
          $set: {
            resolvedAt: new Date().toISOString(),
            isTcp: false,
            resolvedVia: "reconciliation:stale_network_cleanup",
            reconciledAt: new Date(),
          },
        },
        { new: true },
      );
      if (updated) resolved++;
    } catch (e: any) {
      errors++;
      log.warn("stale_alert_cleanup.update.error", {
        alertId: alert.alertId,
        message: e?.message,
      });
    }
  }

  const summary: StaleAlertCleanupSummary = {
    candidates: candidates.length,
    matchedByNetworkPattern: matches.length,
    resolved,
    errors,
    patterns,
  };

  log.info("stale_alert_cleanup.summary", { ...summary });
  await job?.log(`Resueltas: ${resolved}. Errores: ${errors}.`);
  return summary;
}
