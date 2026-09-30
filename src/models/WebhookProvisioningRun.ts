import { Schema, model, Document } from "mongoose";

/**
 * Registro permanente de cada corrida de `apply()` del aprovisionamiento
 * masivo de webhooks Meraki -- un documento por corrida, actualizado de
 * forma incremental (no insertado una sola vez al final) para que si el
 * proceso se cae a mitad de un rollout grande, el documento igual refleje
 * qué networks sí se alcanzaron a procesar antes de la caída (ver
 * "Reglas de seguridad e idempotencia" en PLAN_APROVISIONAMIENTO_WEBHOOKS_
 * MERAKI.md: "Registrar cada ejecución... Permitir reanudar una ejecución
 * parcialmente fallida").
 *
 * `preview` NO se persiste acá -- nunca escribe nada en Meraki, no hay
 * nada que "reanudar" ni auditar de una corrida de solo lectura.
 */

export interface IWebhookProvisioningNetworkResult {
  organizationId: string;
  organizationName: string;
  networkId: string;
  networkName: string;
  networkTags: string[];
  templateAction: string;
  receiverAction: string;
  alertSettingsAction: string;
  payloadTemplateId?: string;
  httpServerId?: string;
  status: string;
  error?: string;
}

export interface IWebhookProvisioningRun extends Document {
  runId: string;
  status: "running" | "completed" | "failed";
  // Body original del request -- seguro de guardar tal cual: secretSource
  // es siempre el nombre fijo de la env var, nunca el secreto real (ver
  // validación en merakiWebhookProvisioning.service.ts).
  request: Record<string, any>;
  configurationVersion: string;
  startedAt: Date;
  finishedAt?: Date;
  networksRequested: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  networks: IWebhookProvisioningNetworkResult[];
  // Solo presente si la corrida ENTERA no pudo terminar (ej. resolveConfiguration
  // tiró antes de empezar a procesar networks) -- distinto de un `error` por
  // network individual, que vive dentro de cada item de `networks`.
  error?: string;
}

const networkResultSchema = new Schema<IWebhookProvisioningNetworkResult>(
  {
    organizationId: { type: String, required: true },
    organizationName: { type: String, required: true },
    networkId: { type: String, required: true },
    networkName: { type: String, required: true },
    networkTags: { type: [String], default: [] },
    templateAction: { type: String, required: true },
    receiverAction: { type: String, required: true },
    alertSettingsAction: { type: String, required: true },
    payloadTemplateId: { type: String, required: false },
    httpServerId: { type: String, required: false },
    status: { type: String, required: true },
    error: { type: String, required: false },
  },
  { _id: false },
);

const webhookProvisioningRunSchema = new Schema<IWebhookProvisioningRun>(
  {
    runId: { type: String, required: true, unique: true, index: true },
    status: { type: String, required: true, index: true },
    request: { type: Schema.Types.Mixed, required: true },
    // No required: al crearse el run todavía no se conoce (se resuelve
    // recién dentro de apply(), después de crear el doc) -- se completa con
    // el valor real si buildPlans() llega a resolverlo, o se queda vacío si
    // la corrida falla antes de eso (ej. organización no permitida).
    configurationVersion: { type: String, required: false, default: "" },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, required: false },
    networksRequested: { type: Number, required: true, default: 0 },
    created: { type: Number, required: true, default: 0 },
    updated: { type: Number, required: true, default: 0 },
    unchanged: { type: Number, required: true, default: 0 },
    skipped: { type: Number, required: true, default: 0 },
    failed: { type: Number, required: true, default: 0 },
    networks: { type: [networkResultSchema], default: [] },
    error: { type: String, required: false },
  },
  { timestamps: true },
);

const WebhookProvisioningRun = model<IWebhookProvisioningRun>(
  "WebhookProvisioningRun",
  webhookProvisioningRunSchema,
);

export default WebhookProvisioningRun;
