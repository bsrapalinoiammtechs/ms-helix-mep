import "dotenv/config";
import mongoose from "mongoose";
import connectDB from "../db/mongodb";
import ReconciliationService from "../services/reconciliation.service";
import { closeMerakiQueue } from "../queues/meraki.queue";
import fs from "fs";
import path from "path";

/**
 * Backfill único del historial de alertas atascadas (Fase E,
 * 01_FIX_ALERTAS_RETENIDAS_2026-05-12.md).
 *
 * `ReconciliationService` normal (el que corre el cron cada hora) solo mira
 * alertas con `startedAt` dentro de los últimos `RECONCILIATION_MAX_AGE_DAYS`
 * (30 por defecto) -- todo lo más viejo que eso cae en `outOfScope` y nunca
 * se vuelve a evaluar contra Meraki. Las alertas de abril/mayo detectadas en
 * el export de Mongo (ms_helix_mep.alerts_2026_07_27.json) ya pasaron esos
 * 30 días hace rato, así que el cron normal jamás las va a cerrar aunque el
 * dispositivo lleve meses `online` en Meraki.
 *
 * Este script corre la MISMA lógica de ReconciliationService pero sin el
 * techo de edad, para procesar todo el backlog histórico de una sola vez.
 *
 * IMPORTANTE -- requiere que el contenedor `ms-helix-mep` de esta
 * organización ya esté corriendo (`docker compose up -d`): este script NO
 * levanta su propio Worker de la cola `meraki-api-calls`, solo encola jobs
 * y espera a que el Worker del proceso principal (el que ya vive en el
 * container) los procese. Así se respeta el gateway único de rate-limit
 * hacia Meraki (concurrency:1) documentado en `meraki.queue.ts` -- correr un
 * segundo worker en paralelo rompería esa garantía.
 *
 * Uso (desde la carpeta de la organización, ej. ms-helix-mep3/ para mep):
 *
 *   npm run build
 *   node build/scripts/backfillReconciliation.js
 *
 * Por defecto corre en DRY RUN (no escribe nada en Mongo) e imprime un
 * resumen + dos archivos JSON (matched / not-found) para revisar antes de
 * aplicar. Para aplicar de verdad:
 *
 *   BACKFILL_DRY_RUN=false node build/scripts/backfillReconciliation.js
 *
 * Variables opcionales:
 *   BACKFILL_MAX_AGE_DAYS   (default 3650 -- ~10 años, efectivamente "todo")
 *   BACKFILL_DRY_RUN        (default "true")
 */

const MAX_AGE_DAYS = parseInt(process.env.BACKFILL_MAX_AGE_DAYS || "3650", 10);
const DRY_RUN = process.env.BACKFILL_DRY_RUN !== "false";

async function main() {
  console.log("=== Backfill de reconciliación (Fase E) ===");
  console.log(`max_age_days=${MAX_AGE_DAYS} dry_run=${DRY_RUN}`);
  console.log(
    DRY_RUN
      ? "Modo DRY RUN: no se va a modificar nada en Mongo, solo se reporta."
      : "Modo APLICAR: las alertas que hagan match SI se van a marcar resolvedAt en Mongo.",
  );

  await connectDB();

  const service = new ReconciliationService({
    maxAgeDays: MAX_AGE_DAYS,
    dryRun: DRY_RUN,
    source: "backfill",
  });

  const summary = await service.run();

  if (!summary) {
    console.error(
      "El servicio no devolvió resumen (config faltante, ya estaba corriendo, o error -- revisar logs arriba).",
    );
    process.exitCode = 1;
  } else {
    console.log("\n--- Resumen ---");
    console.log(`Total atascadas (resolvedAt:null, isGlpi:true, >1h):  ${summary.totalStuck}`);
    console.log(`Dentro de alcance (con max_age_days=${MAX_AGE_DAYS}):  ${summary.inScope}`);
    console.log(`Fuera de alcance (aún más viejas que eso):            ${summary.outOfScope}`);
    console.log(`Redes consultadas contra Meraki:                      ${summary.networksQueried}`);
    console.log(`Páginas totales pedidas a Meraki:                     ${summary.pagesTotal}`);
    console.log(`Match contra "resueltas" de Meraki:                   ${summary.matched}`);
    console.log(`${DRY_RUN ? "Se marcarían" : "Marcadas"} resolvedAt en Mongo:             ${DRY_RUN ? summary.matched : summary.updated}`);
    console.log(`Sin match (Meraki no las reporta como resueltas):     ${summary.notFound}`);
    console.log(`Errores:                                              ${summary.errors}`);

    const outDir = path.join(__dirname, "..", "..", "backfill-output");
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outFile = path.join(outDir, `reconciliation-backfill_${stamp}.json`);
    fs.writeFileSync(outFile, JSON.stringify(summary, null, 2), "utf-8");
    console.log(`\nResultado completo (incluye matched/not-found) guardado en:\n  ${outFile}`);
    console.log(
      "También quedó insertado como documento en Mongo, colección `reconciliationruns`" +
        ' (filtrar por source:"backfill" en Compass) -- no depende de este archivo local.' +
        " Las alertas que sí se cerraron (modo no-dry-run) además quedan marcadas en su propio" +
        ' documento en `alerts` con resolvedVia:"reconciliation:backfill" y reconciledAt.',
    );

    if (summary.notFound > 0) {
      console.log(
        `\n${summary.notFound} alertas siguen sin match. Para éstas, Meraki ya no reporta su` +
          " resolución (probablemente por retención del endpoint) o siguen activas de verdad." +
          " Ese es el grupo candidato para el fallback por estado de dispositivo (Fase E, paso 2)" +
          " -- todavía no implementado, pendiente de confirmar con el usuario.",
      );
    }
  }

  await closeMerakiQueue();
  await mongoose.disconnect();
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error("backfill.fatal_error", err);
  process.exit(1);
});
