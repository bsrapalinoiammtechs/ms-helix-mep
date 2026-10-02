import crypto from "crypto";
import { fetchMerakiPage, MerakiHttpResult } from "../queues/meraki.queue";
import {
  MERAKI_HELIX_TEMPLATE_BODY,
  MERAKI_HELIX_TEMPLATE_HEADERS,
  MERAKI_HELIX_TEMPLATE_NAME,
  MERAKI_HELIX_TEMPLATE_VERSION,
} from "../config/merakiWebhookTemplate";
import {
  AlertSettingsAction,
  ConfigurationSource,
  DestinationMode,
  NetworkSelector,
  OrganizationSelector,
  ProvisioningAction,
  WebhookProvisioningApplyResult,
  WebhookProvisioningNetworkPlan,
  WebhookProvisioningPreview,
  WebhookProvisioningRequest,
} from "../interfaces/IMerakiWebhookProvisioning";
import { log } from "../utils/logger";
import WebhookProvisioningRun from "../models/WebhookProvisioningRun";

const API_BASE = "https://api.meraki.com/api/v1";

interface MerakiOrganization {
  id: string;
  name: string;
}

interface MerakiNetwork {
  id: string;
  organizationId: string;
  name: string;
  tags?: string[];
}

interface MerakiPayloadTemplate {
  payloadTemplateId: string;
  name: string;
  type?: string;
  body?: string;
  headers?: Array<{ name: string; template: string }>;
}

interface MerakiHttpServer {
  id: string;
  name: string;
  url: string;
  enabled?: boolean;
  payloadTemplate?: {
    payloadTemplateId?: string;
    id?: string;
    name?: string;
  };
}

// Forma real de GET/PUT /networks/{id}/alerts/settings -- se pasa `[key:
// string]: any` a propósito, además de los campos que sí leemos/tocamos:
// Meraki devuelve más campos de los documentados según el tipo de red
// (ej. "muting"), y hay que preservarlos intactos en el PUT o Meraki los
// resetea a su default.
interface MerakiAlertDestinations {
  emails?: string[];
  snmp?: boolean;
  httpServerIds?: string[];
  allAdmins?: boolean;
  [key: string]: any;
}

interface MerakiAlertTypeSetting {
  type: string;
  enabled?: boolean;
  alertDestinations?: MerakiAlertDestinations;
  [key: string]: any;
}

interface MerakiAlertsSettings {
  defaultDestinations?: MerakiAlertDestinations;
  alerts?: MerakiAlertTypeSetting[];
  [key: string]: any;
}

interface ResolvedConfiguration {
  version: string;
  templateName: string;
  templateBody: string;
  templateHeaders: Array<{ name: string; template: string }>;
  receiverName: string;
  receiverUrl: string;
  secretSource: string;
  destinationMode: DestinationMode;
  alertTypes: string[];
}

// Plan "rico" de uso interno -- carga además el snapshot de alerts/settings
// que ya se tuvo que pedir para calcular alertSettingsAction, así apply()
// no necesita volver a pedirlo (y arriesgarse a un diff contra un estado
// más nuevo que el que preview() ya mostró). NUNCA se devuelve tal cual por
// la API pública -- preview() lo aplana a WebhookProvisioningNetworkPlan.
interface InternalNetworkPlan extends WebhookProvisioningNetworkPlan {
  currentAlertsSettings: MerakiAlertsSettings;
}

// El body del template es JSON + tags Liquid ({{ }} / {% %}), no JSON puro
// -- no se puede normalizar parseando (los tags Liquid rompen JSON.parse),
// así que se normaliza como texto. Encontrado en vivo (29-sep-2026): el
// mismo contenido editado a mano en el dashboard de Meraki volvía con
// indentación distinta, sin espacio después de ":" en algunas líneas
// ("networkId":"...") y con/sin espacios dentro de "{{ deviceTags |
// jsonify }}" -- ninguna de esas diferencias cambia el resultado real del
// template, pero antes de este fix SÍ cambiaban el hash, marcando "update"
// para siempre en cada comparación aunque el contenido fuera funcionalmente
// idéntico (falso positivo, iba en contra del principio de idempotencia
// del propio plan de aprovisionamiento).
//
// Se descarta TODO whitespace que esté fuera de comillas dobles
// (indentación, saltos de línea, espacio alrededor de ":"/","), y se
// preserva intacto el contenido de cada string literal -- ahí es donde
// viven los tags Liquid, cuyo espaciado interno se normaliza aparte.
function stripWhitespaceOutsideStrings(value: string): string {
  let result = "";
  let insideString = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '"' && value[i - 1] !== "\\") {
      insideString = !insideString;
      result += char;
      continue;
    }
    if (!insideString && /\s/.test(char)) continue;
    result += char;
  }
  return result;
}

function normalizeText(value: string): string {
  return stripWhitespaceOutsideStrings(value.replace(/\r\n/g, "\n"))
    .replace(/\{\{\s*(.*?)\s*\}\}/g, "{{$1}}")
    .replace(/\{%\s*(.*?)\s*%\}/g, "{%$1%}");
}

function normalizeHeaders(
  headers: Array<{ name: string; template: string }> = [],
): Array<{ name: string; template: string }> {
  return headers
    .map((header) => ({
      name: header.name.trim(),
      template: normalizeText(header.template),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function templateHash(
  body: string,
  headers: Array<{ name: string; template: string }> = [],
): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ body: normalizeText(body), headers: normalizeHeaders(headers) }))
    .digest("hex");
}

function getNextUrl(headers: Record<string, any>): string | null {
  const match = String(headers.link ?? "").match(/<([^>]+)>;\s*rel=next/);
  return match?.[1] ?? null;
}

async function merakiRequest(
  method: "GET" | "POST" | "PUT",
  url: string,
  data?: Record<string, any>,
  sharedSecretEnv?: string,
): Promise<MerakiHttpResult> {
  const result = await fetchMerakiPage(
    { url, method, data, sharedSecretEnv },
    `webhook-provisioning-${method.toLowerCase()}`,
  );
  if (!result) throw new Error(`Meraki no respondió a ${method} ${url}`);
  if (result.status < 200 || result.status >= 300) {
    const responseErrors = Array.isArray(result.data?.errors)
      ? result.data.errors.join("; ")
      : result.data?.error ?? result.data?.message;
    const detail = responseErrors ? `: ${String(responseErrors)}` : "";
    throw new Error(`Meraki respondió ${result.status} a ${method} ${url}${detail}`);
  }
  return result;
}

async function getAllPages<T>(url: string): Promise<T[]> {
  const rows: T[] = [];
  let nextUrl: string | null = url;
  while (nextUrl) {
    const result = await merakiRequest("GET", nextUrl);
    if (Array.isArray(result.data)) rows.push(...(result.data as T[]));
    nextUrl = getNextUrl(result.headers);
  }
  return rows;
}

// Comportamiento original, sin cambios -- toma el template de las
// constantes fijas del repo. Es el default cuando no se manda
// configurationSource (compatibilidad con todo lo ya probado en real).
function resolveVersionedConfiguration(request: WebhookProvisioningRequest): ResolvedConfiguration {
  const configuration: ResolvedConfiguration = {
    version: request.configuration?.version ?? MERAKI_HELIX_TEMPLATE_VERSION,
    templateName: request.configuration?.templateName ?? MERAKI_HELIX_TEMPLATE_NAME,
    templateBody: MERAKI_HELIX_TEMPLATE_BODY,
    templateHeaders: MERAKI_HELIX_TEMPLATE_HEADERS,
    receiverName: request.configuration?.receiverName ?? "MEP Webhook",
    receiverUrl:
      request.configuration?.receiverUrl ??
      process.env.MERAKI_WEBHOOK_RECEIVER_URL ??
      "https://pbscatalyst.ice.go.cr/webhooks/meraki/alerts",
    secretSource:
      request.configuration?.secretSource ?? "MERAKI_WEBHOOK_SHARED_SECRET",
    destinationMode: request.configuration?.destinationMode ?? "default",
    alertTypes: request.configuration?.alertTypes ?? [],
  };
  if (configuration.secretSource !== "MERAKI_WEBHOOK_SHARED_SECRET") {
    throw new Error("secretSource solamente puede ser MERAKI_WEBHOOK_SHARED_SECRET");
  }
  if (configuration.version !== MERAKI_HELIX_TEMPLATE_VERSION) {
    throw new Error(`Versión de template no soportada: ${configuration.version}`);
  }
  if (!configuration.receiverUrl.startsWith("https://")) {
    throw new Error("receiverUrl debe utilizar HTTPS");
  }
  if (configuration.destinationMode === "alertTypes" && !configuration.alertTypes.length) {
    throw new Error('configuration.alertTypes es requerido cuando destinationMode es "alertTypes"');
  }
  return configuration;
}

// Lee el template/receiver/alert settings EN VIVO de un network modelo ya
// configurado a mano en Meraki, en vez de usar las constantes fijas del
// repo. templateName/receiverName siguen siendo obligatorios -- son cómo
// identificamos CUÁL template/receiver copiar si el network modelo tiene
// varios (mismo criterio de búsqueda por nombre que ya usa planNetwork()
// en los networks destino).
async function resolveConfigurationFromReferenceNetwork(
  source: Extract<ConfigurationSource, { mode: "referenceNetwork" }>,
  overrides: WebhookProvisioningRequest["configuration"],
): Promise<ResolvedConfiguration> {
  const templateName = overrides?.templateName;
  const receiverNameFilter = overrides?.receiverName;
  if (!templateName) {
    throw new Error(
      "configuration.templateName es requerido en modo referenceNetwork -- identifica cuál template copiar del network modelo",
    );
  }
  if (!receiverNameFilter) {
    throw new Error(
      "configuration.receiverName es requerido en modo referenceNetwork -- identifica cuál receiver copiar del network modelo",
    );
  }

  const [networkResult, templatesResult, receiversResult, alertsSettingsResult] = await Promise.all([
    merakiRequest("GET", `${API_BASE}/networks/${source.networkId}`),
    merakiRequest("GET", `${API_BASE}/networks/${source.networkId}/webhooks/payloadTemplates`),
    merakiRequest("GET", `${API_BASE}/networks/${source.networkId}/webhooks/httpServers`),
    merakiRequest("GET", `${API_BASE}/networks/${source.networkId}/alerts/settings`),
  ]);
  const templates = Array.isArray(templatesResult.data)
    ? (templatesResult.data as MerakiPayloadTemplate[])
    : [];
  const receivers = Array.isArray(receiversResult.data)
    ? (receiversResult.data as MerakiHttpServer[])
    : [];
  const alertsSettings = (alertsSettingsResult.data ?? {}) as MerakiAlertsSettings;
  const referenceNetworkName = String(networkResult.data?.name ?? "");

  // El network de referencia también pasó por resolveTemplateNameForNetwork
  // al crearse (o se renombró a mano para respetar la convención, como
  // pasó acá) -- así que su template real se llama "{templateName} —
  // {su propio nombre}", no el nombre base a secas. Buscar por el nombre
  // base tal cual (sin sufijo) nunca lo iba a encontrar.
  const resolvedReferenceTemplateName = resolveTemplateNameForNetwork(templateName, referenceNetworkName);
  const referenceTemplate = templates.find(
    (candidate) => candidate.type === "custom" && candidate.name === resolvedReferenceTemplateName,
  );
  if (!referenceTemplate) {
    throw new Error(
      `No se encontró el template "${resolvedReferenceTemplateName}" en el network de referencia ${source.networkId}`,
    );
  }
  const referenceReceiver = receivers.find((candidate) => candidate.name === receiverNameFilter);
  if (!referenceReceiver) {
    throw new Error(
      `No se encontró el receiver "${receiverNameFilter}" en el network de referencia ${source.networkId}`,
    );
  }

  // Validación de consistencia -- si el receiver "modelo" no apunta al
  // template "modelo" nombrado, el network de referencia está mal
  // configurado; mejor fallar temprano acá que replicar esa inconsistencia
  // a todos los networks destino.
  if (receiverTemplateId(referenceReceiver) !== (referenceTemplate.payloadTemplateId ?? "")) {
    throw new Error(
      `El receiver "${receiverNameFilter}" del network de referencia no está asociado al template "${templateName}" -- revisa la configuración del network modelo antes de usarlo como referencia`,
    );
  }

  // destinationMode/alertTypes: si no vienen forzados en `overrides`, se
  // DERIVAN de cómo está asociado el receiver modelo en sus propias alert
  // settings -- así cambiar a qué alertas se asocia el webhook es editar
  // el modelo en Meraki, no tocar código ni el request.
  let destinationMode = overrides?.destinationMode;
  let alertTypes = overrides?.alertTypes ?? [];
  if (!destinationMode) {
    const referenceId = referenceReceiver.id;
    const isDefaultDestination = (alertsSettings.defaultDestinations?.httpServerIds ?? []).includes(
      referenceId,
    );
    const matchingAlertTypes = (alertsSettings.alerts ?? [])
      .filter((alert) => (alert.alertDestinations?.httpServerIds ?? []).includes(referenceId))
      .map((alert) => alert.type);
    if (isDefaultDestination) {
      destinationMode = "default";
    } else if (matchingAlertTypes.length) {
      destinationMode = "alertTypes";
      alertTypes = matchingAlertTypes;
    } else {
      throw new Error(
        `El receiver "${receiverNameFilter}" del network de referencia no está asociado a ningún destino (ni default ni tipos específicos) -- no hay nada que replicar`,
      );
    }
  }

  const secretSource = overrides?.secretSource ?? "MERAKI_WEBHOOK_SHARED_SECRET";
  if (secretSource !== "MERAKI_WEBHOOK_SHARED_SECRET") {
    throw new Error("secretSource solamente puede ser MERAKI_WEBHOOK_SHARED_SECRET");
  }
  const receiverUrl = overrides?.receiverUrl ?? referenceReceiver.url;
  if (!receiverUrl.startsWith("https://")) {
    throw new Error("receiverUrl debe utilizar HTTPS");
  }
  if (destinationMode === "alertTypes" && !alertTypes.length) {
    throw new Error('configuration.alertTypes es requerido cuando destinationMode es "alertTypes"');
  }

  return {
    version: `referenceNetwork:${source.organizationId}/${source.networkId}`,
    templateName,
    templateBody: referenceTemplate.body ?? "",
    templateHeaders: referenceTemplate.headers ?? [],
    receiverName: overrides?.receiverName ?? referenceReceiver.name,
    receiverUrl,
    secretSource,
    destinationMode,
    alertTypes,
  };
}

async function resolveConfiguration(request: WebhookProvisioningRequest): Promise<ResolvedConfiguration> {
  const source: ConfigurationSource = request.configurationSource ?? { mode: "versioned" };
  if (source.mode === "referenceNetwork") {
    return resolveConfigurationFromReferenceNetwork(source, request.configuration);
  }
  return resolveVersionedConfiguration(request);
}

function validateSelector(selector: OrganizationSelector | NetworkSelector): void {
  if (selector.mode === "organizationId" && !selector.id?.trim()) {
    throw new Error("organizationSelector.id es requerido");
  }
  if ((selector.mode === "organizationIds" || selector.mode === "networkIds") && !selector.ids?.length) {
    throw new Error(`${selector.mode}.ids debe contener al menos un ID`);
  }
  if (selector.mode === "tags" && !selector.tags?.length) {
    throw new Error("networkSelector.tags debe contener al menos una etiqueta");
  }
}

// Cada instancia de ms-helix-mep administra UNA sola organización Meraki
// (ORGANIZATION_ID en su propio .env). TOKEN_CISCO es compartido entre las 7
// organizaciones del cliente (acceso delegado tipo MSP, confirmado
// 24-ago-2026) -- sin esta restricción, un organizationSelector mal armado
// (o "all"/"organizationIds" usado por error) podría crear/actualizar
// templates, receivers o alert settings en la organización de OTRO cliente.
// Se puede levantar con WEBHOOK_PROVISIONING_ALLOW_CROSS_ORG=true para una
// instalación que sí necesite administrar varias organizaciones desde un
// solo despliegue -- no es el caso de MEP.
function assertOwnOrganizationOnly(selector: OrganizationSelector): void {
  if (process.env.WEBHOOK_PROVISIONING_ALLOW_CROSS_ORG === "true") return;

  const ownOrgId = (process.env.ORGANIZATION_ID || "").trim();
  if (!ownOrgId) {
    throw new Error(
      "ORGANIZATION_ID no está configurado -- requerido para aprovisionar webhooks en esta instancia (o definir WEBHOOK_PROVISIONING_ALLOW_CROSS_ORG=true si esta instancia debe administrar múltiples organizaciones).",
    );
  }
  if (selector.mode === "all") {
    throw new Error(
      `organizationSelector.mode:"all" está deshabilitado en esta instancia -- solo puede aprovisionar su propia organización (${ownOrgId}). Definir WEBHOOK_PROVISIONING_ALLOW_CROSS_ORG=true para levantar esta restricción.`,
    );
  }
  if (selector.mode === "organizationIds") {
    const outside = selector.ids.filter((id) => id !== ownOrgId);
    if (outside.length) {
      throw new Error(
        `organizationSelector incluye organizaciones fuera del alcance de esta instancia: ${outside.join(", ")}. Esta instancia solo puede aprovisionar ${ownOrgId}.`,
      );
    }
  }
  if (selector.mode === "organizationId" && selector.id !== ownOrgId) {
    throw new Error(
      `organizationSelector.id (${selector.id}) no coincide con la organización de esta instancia (${ownOrgId}).`,
    );
  }
}

async function resolveOrganizations(selector: OrganizationSelector): Promise<MerakiOrganization[]> {
  validateSelector(selector);
  assertOwnOrganizationOnly(selector);
  if (selector.mode === "organizationId") {
    const result = await merakiRequest("GET", `${API_BASE}/organizations/${selector.id}`);
    return [result.data as MerakiOrganization];
  }

  const organizations = await getAllPages<MerakiOrganization>(`${API_BASE}/organizations?perPage=1000`);
  if (selector.mode === "organizationIds") {
    const wanted = new Set(selector.ids);
    const selected = organizations.filter((organization) => wanted.has(organization.id));
    const missing = selector.ids.filter((id) => !selected.some((organization) => organization.id === id));
    if (missing.length) throw new Error(`Organizaciones no encontradas: ${missing.join(", ")}`);
    return selected;
  }
  return organizations;
}

function selectNetworks(networks: MerakiNetwork[], selector: NetworkSelector): MerakiNetwork[] {
  validateSelector(selector);
  if (selector.mode === "all") return networks;
  if (selector.mode === "networkIds") {
    const wanted = new Set(selector.ids);
    return networks.filter((network) => wanted.has(network.id));
  }
  const tags = new Set(selector.tags.map((tag) => tag.toLowerCase()));
  return networks.filter((network) =>
    (network.tags ?? []).some((tag) => tags.has(tag.toLowerCase())),
  );
}

function receiverTemplateId(receiver: MerakiHttpServer): string {
  return receiver.payloadTemplate?.payloadTemplateId ?? receiver.payloadTemplate?.id ?? "";
}

// Meraki exige que el "name" de un Payload Template sea único en TODA la
// organización -- aunque el recurso en sí es independiente por network
// (confirmado en vivo, 29-sep-2026: pedir el template de un network desde
// la URL de OTRO network del mismo org da 404, no es un recurso
// compartido). Sin este sufijo, crear el mismo templateName "bonito" en
// más de un network de la misma organización falla desde el segundo
// network en adelante con 400 "Name validation failed... already exists
// for this organization". Se usa el NOMBRE del network (no el id) por
// pedido explícito del usuario -- más legible en el dashboard de Meraki.
function resolveTemplateNameForNetwork(baseName: string, networkName: string): string {
  return `${baseName} — ${networkName.trim()}`;
}

function chooseTemplateAction(
  current: MerakiPayloadTemplate | undefined,
  configuration: ResolvedConfiguration,
): ProvisioningAction {
  if (!current) return "create";
  return templateHash(current.body ?? "", current.headers ?? []) ===
    templateHash(configuration.templateBody, configuration.templateHeaders)
    ? "unchanged"
    : "update";
}

// El receiver puede no existir todavía en este momento del preview (se va a
// CREAR recién en apply()) -- en ese caso su id todavía no existe en Meraki,
// así que por definición nunca puede estar ya asociado a ningún destino:
// la acción es "update" siempre (hay que asociarlo apenas se cree), salvo
// que el modo "alertTypes" no tenga NINGÚN tipo válido en el catálogo de
// este network puntual, en cuyo caso no hay nada que asociar ("skipped").
function chooseAlertSettingsAction(
  settings: MerakiAlertsSettings,
  receiverId: string | undefined,
  configuration: ResolvedConfiguration,
): { action: AlertSettingsAction; missingAlertTypes?: string[] } {
  if (configuration.destinationMode === "alertTypes") {
    const catalogTypes = new Set((settings.alerts ?? []).map((alert) => alert.type));
    const missing = configuration.alertTypes.filter((type) => !catalogTypes.has(type));
    const validTypes = configuration.alertTypes.filter((type) => catalogTypes.has(type));
    if (!validTypes.length) {
      return { action: "skipped", missingAlertTypes: missing };
    }
    if (!receiverId) {
      return { action: "update", missingAlertTypes: missing.length ? missing : undefined };
    }
    const allPresent = (settings.alerts ?? [])
      .filter((alert) => validTypes.includes(alert.type))
      .every((alert) => (alert.alertDestinations?.httpServerIds ?? []).includes(receiverId));
    return {
      action: allPresent ? "unchanged" : "update",
      missingAlertTypes: missing.length ? missing : undefined,
    };
  }

  if (!receiverId) return { action: "update" };
  const present = (settings.defaultDestinations?.httpServerIds ?? []).includes(receiverId);
  return { action: present ? "unchanged" : "update" };
}

async function planNetwork(
  organization: MerakiOrganization,
  network: MerakiNetwork,
  configuration: ResolvedConfiguration,
): Promise<InternalNetworkPlan> {
  const [templatesResult, receiversResult, alertsSettingsResult] = await Promise.all([
    merakiRequest("GET", `${API_BASE}/networks/${network.id}/webhooks/payloadTemplates`),
    merakiRequest("GET", `${API_BASE}/networks/${network.id}/webhooks/httpServers`),
    merakiRequest("GET", `${API_BASE}/networks/${network.id}/alerts/settings`),
  ]);
  const templates = Array.isArray(templatesResult.data)
    ? (templatesResult.data as MerakiPayloadTemplate[])
    : [];
  const receivers = Array.isArray(receiversResult.data)
    ? (receiversResult.data as MerakiHttpServer[])
    : [];
  const currentAlertsSettings = (alertsSettingsResult.data ?? {}) as MerakiAlertsSettings;

  const resolvedTemplateName = resolveTemplateNameForNetwork(configuration.templateName, network.name);
  const template = templates.find(
    (candidate) => candidate.type === "custom" && candidate.name === resolvedTemplateName,
  );
  const receiver = receivers.find(
    (candidate) =>
      candidate.name === configuration.receiverName || candidate.url === configuration.receiverUrl,
  );
  const templateAction = chooseTemplateAction(template, configuration);
  let receiverAction: ProvisioningAction = "create";
  if (receiver) {
    const expectedTemplateId = template?.payloadTemplateId ?? "";
    receiverAction =
      receiver.name === configuration.receiverName &&
      receiver.url === configuration.receiverUrl &&
      receiver.enabled !== false &&
      receiverTemplateId(receiver) === expectedTemplateId
        ? "unchanged"
        : "update";
  }
  const { action: alertSettingsAction, missingAlertTypes } = chooseAlertSettingsAction(
    currentAlertsSettings,
    receiver?.id,
    configuration,
  );

  return {
    organizationId: organization.id,
    organizationName: organization.name,
    networkId: network.id,
    networkName: network.name,
    networkTags: network.tags ?? [],
    templateAction,
    receiverAction,
    alertSettingsAction,
    missingAlertTypes,
    payloadTemplateId: template?.payloadTemplateId,
    httpServerId: receiver?.id,
    currentTemplateHash: template
      ? templateHash(template.body ?? "", template.headers ?? [])
      : undefined,
    desiredTemplateHash: templateHash(
      configuration.templateBody,
      configuration.templateHeaders,
    ),
    currentAlertsSettings,
  };
}

// Fuente única de la verdad de qué hace falta hacer -- preview() la aplana
// a la forma pública (sin currentAlertsSettings, que solo apply() necesita
// para armar el PUT preservando el resto de la configuración de alertas del
// network); apply() la usa directamente, en vez de llamar a preview() y
// perder ese snapshot en el camino (como pasaba antes de este cambio).
async function buildPlans(
  request: WebhookProvisioningRequest,
): Promise<{ configuration: ResolvedConfiguration; organizationsCount: number; plans: InternalNetworkPlan[] }> {
  const configuration = await resolveConfiguration(request);
  const organizations = await resolveOrganizations(request.organizationSelector);
  const plans: InternalNetworkPlan[] = [];

  for (const organization of organizations) {
    const networks = await getAllPages<MerakiNetwork>(
      `${API_BASE}/organizations/${organization.id}/networks?perPage=1000`,
    );
    const selected = selectNetworks(networks, request.networkSelector);
    for (const network of selected) {
      plans.push(await planNetwork(organization, network, configuration));
    }
  }

  if (request.networkSelector.mode === "networkIds") {
    const found = new Set(plans.map((plan) => plan.networkId));
    const missing = request.networkSelector.ids.filter((id) => !found.has(id));
    if (missing.length) throw new Error(`Networks no encontrados: ${missing.join(", ")}`);
  }

  return { configuration, organizationsCount: organizations.length, plans };
}

function toPublicPlan(plan: InternalNetworkPlan): WebhookProvisioningNetworkPlan {
  const { currentAlertsSettings, ...publicPlan } = plan;
  return publicPlan;
}

export class MerakiWebhookProvisioningService {
  async preview(request: WebhookProvisioningRequest): Promise<WebhookProvisioningPreview> {
    const { configuration, organizationsCount, plans } = await buildPlans(request);

    const preview: WebhookProvisioningPreview = {
      mode: "preview",
      configurationVersion: configuration.version,
      organizationsFound: organizationsCount,
      networksFound: plans.length,
      summary: {
        templatesToCreate: plans.filter((plan) => plan.templateAction === "create").length,
        templatesToUpdate: plans.filter((plan) => plan.templateAction === "update").length,
        receiversToCreate: plans.filter((plan) => plan.receiverAction === "create").length,
        receiversToUpdate: plans.filter((plan) => plan.receiverAction === "update").length,
        alertSettingsToUpdate: plans.filter((plan) => plan.alertSettingsAction === "update").length,
        alertSettingsSkipped: plans.filter((plan) => plan.alertSettingsAction === "skipped").length,
        unchanged: plans.filter(
          (plan) =>
            plan.templateAction === "unchanged" &&
            plan.receiverAction === "unchanged" &&
            plan.alertSettingsAction === "unchanged",
        ).length,
      },
      networks: plans.map(toPublicPlan),
    };
    log.info("webhook_provisioning.preview", preview.summary);
    return preview;
  }

  async apply(request: WebhookProvisioningRequest): Promise<WebhookProvisioningApplyResult> {
    // Gate adicional y separado del `confirm:true` genérico de la ruta --
    // ese solo confirma "ya revisé el preview"; este obliga a una
    // confirmación explícita puntual para el modo de mayor alcance dentro
    // de la organización (todos sus networks de una sola corrida), para no
    // lanzar un rollout masivo sin haber piloteado antes contra un
    // subconjunto (networkIds/tags). No aplica a preview: solo lee.
    if (request.networkSelector.mode === "all" && request.confirmFullRollout !== true) {
      throw new Error(
        'networkSelector.mode:"all" en apply requiere confirmFullRollout:true -- valida primero contra un subconjunto piloto (networkIds/tags) antes de lanzar contra todos los networks de la organización.',
      );
    }

    // runId se genera ANTES de resolver la config/planes -- así, si algo
    // truena ahí mismo (ej. secretSource faltante, network de referencia
    // no encontrado), igual queda un documento "failed" consultable, no
    // solo un 400 que se pierde en el momento si nadie estaba mirando la
    // respuesta HTTP en vivo.
    const runId = crypto.randomUUID();
    const startedAt = new Date();
    const run = await WebhookProvisioningRun.create({
      runId,
      status: "running",
      request,
      configurationVersion: "",
      startedAt,
      networks: [],
    });

    let configuration: ResolvedConfiguration;
    let plans: InternalNetworkPlan[];
    try {
      ({ configuration, plans } = await buildPlans(request));
      if (!process.env[configuration.secretSource]) {
        throw new Error(`Missing environment variable: ${configuration.secretSource}`);
      }
      run.configurationVersion = configuration.version;
      run.networksRequested = plans.length;
      await run.save();
    } catch (error: any) {
      run.status = "failed";
      run.error = error?.message ?? "Error desconocido";
      run.finishedAt = new Date();
      await run.save();
      throw error;
    }

    const results: WebhookProvisioningApplyResult["networks"] = [];

    for (const plan of plans) {
      try {
        let templateId = plan.payloadTemplateId;
        const resolvedTemplateName = resolveTemplateNameForNetwork(
          configuration.templateName,
          plan.networkName,
        );
        if (plan.templateAction === "create") {
          const created = await merakiRequest(
            "POST",
            `${API_BASE}/networks/${plan.networkId}/webhooks/payloadTemplates`,
            {
              name: resolvedTemplateName,
              body: configuration.templateBody,
              headers: configuration.templateHeaders,
            },
          );
          templateId = String(created.data?.payloadTemplateId ?? "");
        } else if (plan.templateAction === "update") {
          await merakiRequest(
            "PUT",
            `${API_BASE}/networks/${plan.networkId}/webhooks/payloadTemplates/${templateId}`,
            {
              name: resolvedTemplateName,
              body: configuration.templateBody,
              headers: configuration.templateHeaders,
            },
          );
        }
        if (!templateId) throw new Error("Meraki no devolvió payloadTemplateId");

        const receiverData = {
          name: configuration.receiverName,
          url: configuration.receiverUrl,
          payloadTemplate: { payloadTemplateId: templateId },
        };
        let httpServerId = plan.httpServerId;
        if (plan.receiverAction === "create") {
          const created = await merakiRequest(
            "POST",
            `${API_BASE}/networks/${plan.networkId}/webhooks/httpServers`,
            receiverData,
            configuration.secretSource,
          );
          httpServerId = String(created.data?.id ?? "");
          if (!httpServerId) throw new Error("Meraki no devolvió el id del receiver creado");
        } else if (plan.receiverAction === "update") {
          await merakiRequest(
            "PUT",
            `${API_BASE}/networks/${plan.networkId}/webhooks/httpServers/${plan.httpServerId}`,
            receiverData,
            configuration.secretSource,
          );
        }

        // Alert settings -- va DESPUÉS de asegurar el receiver, porque acá
        // sí necesitamos su id real (si se acaba de crear, plan.httpServerId
        // todavía tenía el valor de cuando se armó el plan: undefined).
        if (plan.alertSettingsAction === "update") {
          const current = plan.currentAlertsSettings;
          const body: MerakiAlertsSettings =
            configuration.destinationMode === "alertTypes"
              ? {
                  ...current,
                  // "alertTypes" significa SOLO estos tipos -- si el receiver
                  // ya estaba en defaultDestinations (p.ej. de un rollout
                  // previo en modo "default"), hay que sacarlo de ahí o
                  // seguiría recibiendo TODOS los tipos habilitados además de
                  // los elegidos acá.
                  defaultDestinations: {
                    ...current.defaultDestinations,
                    httpServerIds: (current.defaultDestinations?.httpServerIds ?? []).filter(
                      (id) => id !== httpServerId,
                    ),
                  },
                  alerts: (current.alerts ?? []).map((alert) => {
                    if (!configuration.alertTypes.includes(alert.type)) return alert;
                    const existingIds = alert.alertDestinations?.httpServerIds ?? [];
                    return {
                      ...alert,
                      alertDestinations: {
                        ...alert.alertDestinations,
                        httpServerIds: existingIds.includes(httpServerId!)
                          ? existingIds
                          : [...existingIds, httpServerId!],
                      },
                    };
                  }),
                }
              : {
                  ...current,
                  defaultDestinations: {
                    ...current.defaultDestinations,
                    httpServerIds: (current.defaultDestinations?.httpServerIds ?? []).includes(
                      httpServerId!,
                    )
                      ? current.defaultDestinations?.httpServerIds
                      : [...(current.defaultDestinations?.httpServerIds ?? []), httpServerId!],
                  },
                };
          await merakiRequest("PUT", `${API_BASE}/networks/${plan.networkId}/alerts/settings`, body);
        }

        const changed =
          plan.templateAction !== "unchanged" ||
          plan.receiverAction !== "unchanged" ||
          plan.alertSettingsAction === "update";
        const status = changed
          ? plan.templateAction === "create" || plan.receiverAction === "create"
            ? "created"
            : "updated"
          : plan.alertSettingsAction === "skipped"
            ? "skipped"
            : "unchanged";
        const networkResult: WebhookProvisioningApplyResult["networks"][number] = {
          ...toPublicPlan(plan),
          httpServerId,
          status,
        };
        results.push(networkResult);
        // Guardado incremental -- ver comentario del modelo: si el proceso
        // se cae acá (network 30 de 100, ej.), el documento ya refleja los
        // 30 que sí se alcanzaron a procesar, no queda todo en el limbo.
        run.networks.push(networkResult as any);
        await run.save();
      } catch (error: any) {
        log.error("webhook_provisioning.network.failed", {
          networkId: plan.networkId,
          message: error?.message,
        });
        const networkResult = {
          ...toPublicPlan(plan),
          status: "failed" as const,
          error: error?.message ?? "Error desconocido",
        };
        results.push(networkResult);
        run.networks.push(networkResult as any);
        await run.save();
      }
    }

    run.status = "completed";
    run.finishedAt = new Date();
    run.created = results.filter((result) => result.status === "created").length;
    run.updated = results.filter((result) => result.status === "updated").length;
    run.unchanged = results.filter((result) => result.status === "unchanged").length;
    run.skipped = results.filter((result) => result.status === "skipped").length;
    run.failed = results.filter((result) => result.status === "failed").length;
    await run.save();

    return {
      mode: "apply",
      runId,
      configurationVersion: configuration.version,
      networksRequested: results.length,
      created: run.created,
      updated: run.updated,
      unchanged: run.unchanged,
      skipped: run.skipped,
      failed: run.failed,
      networks: results,
    };
  }
}

export default MerakiWebhookProvisioningService;

