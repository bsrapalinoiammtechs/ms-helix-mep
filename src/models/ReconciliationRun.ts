import { Schema, model, Document } from "mongoose";

/**
 * Registro permanente de cada corrida de ReconciliationService -- tanto el
 * cron horario normal ("cron") como el backfill one-off de Fase E
 * ("backfill", ver `src/scripts/backfillReconciliation.ts`). Un documento
 * por corrida, insert-only (no upsert), para poder responder en Compass
 * "qué alertas tocó tal corrida" sin depender de un archivo en el host.
 *
 * `SyncState`/`recordSync` (ver `src/models/SyncState.ts`) sigue existiendo
 * para el estado "última corrida" que lee `/health` -- este modelo es el
 * histórico completo, con el detalle por alerta.
 */

export interface IReconciliationAlertRef {
  alertId: string;
  networkId?: string;
  startedAt: string;
  resolvedAt?: string; // solo presente en matchedAlerts
}

// Resultado de la segunda pasada por lookup individual (ver
// ReconciliationService.forceResolveStuckAlertsByIdLookup) -- alertas
// atascadas >RECONCILIATION_FORCE_LOOKUP_STUCK_DAYS (default 2 días) que se
// verifican una por una contra Meraki (GET assurance/alerts/{id}), no por el
// escaneo paginado de la red (que puede enterrar alertas viejas). No tiene
// el límite de 30 días de `maxAgeDays` -- ese límite existe por la
// paginación, que este camino no usa.
export interface IReconciliationForceLookup {
  candidates: number;
  checked: number;
  // Meraki confirmó resolvedAt/dismissedAt real -- resolvedVia queda como
  // "reconciliation:force_lookup:<source>".
  resolvedCesada: number;
  // Meraki ya no tiene el id (404) -- se resuelve igual pero con la fecha de
  // detección (no la real, que no se puede saber), resolvedVia
  // "reconciliation:force_not_found:<source>".
  resolvedNotFound: number;
  stillActive: number;
  errors: number;
}

export interface IReconciliationRun extends Document {
  runAt: Date;
  source: string; // "cron" | "backfill"
  dryRun: boolean;
  maxAgeDays: number;
  totalStuck: number;
  inScope: number;
  outOfScope: number;
  networksQueried: number;
  pagesTotal: number;
  matched: number;
  updated: number;
  notFound: number;
  // Nombrado `errorCount` (no `errors`) -- ese nombre colisiona con la
  // propiedad `errors` que mongoose.Document ya reserva para validación.
  errorCount: number;
  durationMs: number;
  matchedAlerts: IReconciliationAlertRef[];
  notFoundAlerts: IReconciliationAlertRef[];
  forceLookup?: IReconciliationForceLookup;
}

const alertRefSchema = new Schema<IReconciliationAlertRef>(
  {
    alertId: { type: String, required: true },
    networkId: { type: String, required: false },
    startedAt: { type: String, required: true },
    resolvedAt: { type: String, required: false },
  },
  { _id: false },
);

const forceLookupSchema = new Schema<IReconciliationForceLookup>(
  {
    candidates: { type: Number, required: true, default: 0 },
    checked: { type: Number, required: true, default: 0 },
    resolvedCesada: { type: Number, required: true, default: 0 },
    resolvedNotFound: { type: Number, required: true, default: 0 },
    stillActive: { type: Number, required: true, default: 0 },
    errors: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

const reconciliationRunSchema = new Schema<IReconciliationRun>(
  {
    runAt: { type: Date, required: true, index: true },
    source: { type: String, required: true, index: true },
    dryRun: { type: Boolean, required: true },
    maxAgeDays: { type: Number, required: true },
    totalStuck: { type: Number, required: true },
    inScope: { type: Number, required: true },
    outOfScope: { type: Number, required: true },
    networksQueried: { type: Number, required: true },
    pagesTotal: { type: Number, required: true },
    matched: { type: Number, required: true },
    updated: { type: Number, required: true },
    notFound: { type: Number, required: true },
    errorCount: { type: Number, required: true },
    durationMs: { type: Number, required: true },
    matchedAlerts: { type: [alertRefSchema], default: [] },
    notFoundAlerts: { type: [alertRefSchema], default: [] },
    forceLookup: { type: forceLookupSchema, required: false },
  },
  { timestamps: true },
);

const ReconciliationRun = model<IReconciliationRun>(
  "ReconciliationRun",
  reconciliationRunSchema,
);

export default ReconciliationRun;
