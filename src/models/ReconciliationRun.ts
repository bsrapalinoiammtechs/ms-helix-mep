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
  },
  { timestamps: true },
);

const ReconciliationRun = model<IReconciliationRun>(
  "ReconciliationRun",
  reconciliationRunSchema,
);

export default ReconciliationRun;
