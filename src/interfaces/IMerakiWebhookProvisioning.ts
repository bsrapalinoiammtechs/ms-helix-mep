export type OrganizationSelector =
  | { mode: "organizationId"; id: string }
  | { mode: "organizationIds"; ids: string[] }
  | { mode: "all" };

export type NetworkSelector =
  | { mode: "all" }
  | { mode: "networkIds"; ids: string[] }
  | { mode: "tags"; tags: string[] };

// "default": agrega el receiver a defaultDestinations.httpServerIds (llega
// cualquier alerta que ya esté configurada para notificar por webhook).
// "alertTypes": agrega el receiver SOLO a los tipos de alerta listados en
// alertTypes, sin tocar defaultDestinations -- útil cuando no se quiere que
// el receiver reciba todo lo que ya está configurado por defecto.
export type DestinationMode = "default" | "alertTypes";

// "versioned": el template/receiver a desplegar salen de constantes fijas
// en el repo (config/merakiWebhookTemplate.ts) -- cambiar el contenido
// exige editar código y redeployar ms-helix-mep.
// "referenceNetwork": el template/receiver/alert settings a desplegar se
// LEEN en vivo de un network real ya configurado a mano en el dashboard de
// Meraki (el "modelo") -- cambiar el contenido es editar ese network en
// Meraki, sin tocar código. Sus IDs (payloadTemplateId/httpServerId) nunca
// se copian a los networks destino -- son únicos por network, no
// portables; solo se copia el CONTENIDO (body/headers/nombre/url/tipos de
// alerta asociados).
export type ConfigurationSource =
  | { mode: "versioned"; version?: string }
  | { mode: "referenceNetwork"; organizationId: string; networkId: string };

export interface WebhookProvisioningRequest {
  // Restringido por diseño a la organización configurada en ORGANIZATION_ID
  // de esta instancia (ver WEBHOOK_PROVISIONING_ALLOW_CROSS_ORG) -- cada
  // instancia de ms-helix-mep administra una sola organización Meraki, y
  // TOKEN_CISCO es compartido entre las 7 organizaciones del cliente (MSP),
  // así que sin esta restricción una instancia podría tocar por error la
  // organización de OTRO cliente.
  organizationSelector: OrganizationSelector;
  networkSelector: NetworkSelector;
  // Requerido (además de `confirm` en la ruta) cuando networkSelector.mode
  // es "all" en apply -- fuerza una confirmación explícita y separada antes
  // de tocar TODOS los networks de la organización, para no lanzar un
  // rollout masivo sin haber validado antes contra un subconjunto piloto
  // (networkIds/tags). No aplica a preview (solo lee, no escribe).
  confirmFullRollout?: boolean;
  // Sin especificar, default { mode: "versioned" } -- mismo comportamiento
  // de siempre, no rompe requests existentes.
  configurationSource?: ConfigurationSource;
  configuration?: {
    version?: string;
    // En modo "referenceNetwork", templateName/receiverName son
    // OBLIGATORIOS -- se usan para identificar cuál template/receiver del
    // network modelo copiar (puede tener varios). En modo "versioned" son
    // opcionales, con default a los valores fijos del repo.
    templateName?: string;
    receiverName?: string;
    // En "referenceNetwork", si se omite, se toma la URL real del receiver
    // modelo -- pasarlo explícito solo si el destino final debe ser
    // distinto al del modelo.
    receiverUrl?: string;
    secretSource?: string;
    // En "referenceNetwork", si se omiten, se DERIVAN de cómo está
    // asociado el receiver modelo en las alert settings de su network (si
    // está en defaultDestinations -> "default"; si está asociado a tipos
    // puntuales -> "alertTypes" con esos tipos) -- pasarlos explícito solo
    // para forzar algo distinto a lo que ya tiene configurado el modelo.
    destinationMode?: DestinationMode;
    alertTypes?: string[];
  };
}

export type ProvisioningAction = "create" | "update" | "unchanged";

// "skipped" es propio de alertSettingsAction -- se da cuando ninguno de los
// alertTypes pedidos existe en el catálogo de ESE network puntual (redes
// heterogéneas: no todas tienen los mismos tipos de dispositivo/alerta), y
// por lo tanto no hay nada que asociar ahí sin inventar un tipo que Meraki
// rechazaría.
export type AlertSettingsAction = ProvisioningAction | "skipped";

export interface WebhookProvisioningNetworkPlan {
  organizationId: string;
  organizationName: string;
  networkId: string;
  networkName: string;
  networkTags: string[];
  templateAction: ProvisioningAction;
  receiverAction: ProvisioningAction;
  alertSettingsAction: AlertSettingsAction;
  payloadTemplateId?: string;
  httpServerId?: string;
  currentTemplateHash?: string;
  desiredTemplateHash: string;
  // Solo presente en modo "alertTypes" cuando alguno de los tipos pedidos
  // no existe en el catálogo de este network -- informativo, no bloquea el
  // resto de tipos que sí existan.
  missingAlertTypes?: string[];
}

export interface WebhookProvisioningPreview {
  mode: "preview";
  configurationVersion: string;
  organizationsFound: number;
  networksFound: number;
  summary: {
    templatesToCreate: number;
    templatesToUpdate: number;
    receiversToCreate: number;
    receiversToUpdate: number;
    alertSettingsToUpdate: number;
    alertSettingsSkipped: number;
    unchanged: number;
  };
  networks: WebhookProvisioningNetworkPlan[];
}

export interface WebhookProvisioningApplyResult {
  mode: "apply";
  // Id de la corrida persistida en Mongo (colección WebhookProvisioningRun)
  // -- se puede consultar después con GET /admin/meraki/webhook-provisioning/runs/:runId,
  // útil sobre todo si la corrida es grande y la conexión HTTP se corta
  // antes de que termine.
  runId: string;
  configurationVersion: string;
  networksRequested: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  networks: Array<
    WebhookProvisioningNetworkPlan & {
      status: "created" | "updated" | "unchanged" | "skipped" | "failed";
      error?: string;
    }
  >;
}

