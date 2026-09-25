/**
 * Forma del payload que Meraki envía a un HTTP server configurado como
 * receptor de Webhooks. Campos comunes según la documentación pública
 * (developer.cisco.com/meraki/webhooks/introduction/) -- `alertData` varía
 * según `alertType` y su forma exacta TODAVÍA NO está confirmada contra un
 * payload real para alertas de conectividad/caída (pendiente probar con
 * "Send test" en el Dashboard, o con una alerta real -- ver
 * 01_FIX_ALERTAS_RETENIDAS_2026-05-12.md, sección FASE C).
 *
 * Se deja `[key: string]: any` a propósito para no perder campos que
 * aparezcan en el payload real y todavía no estén tipados acá.
 */
export interface MerakiWebhookAlertPayload {
  version?: string;
  sharedSecret?: string;
  sentAt?: string;
  occurredAt?: string;
  startedAt?: string;
  dismissedAt?: string | null;
  resolvedAt?: string | null;
  expiresAt?: string | null;
  organizationId?: string;
  organizationName?: string;
  organizationUrl?: string;
  networkId?: string;
  networkName?: string;
  networkUrl?: string;
  networkTags?: string[];
  alertId?: string;
  alertType?: string;
  categoryType?: string;
  deviceType?: string;
  title?: string;
  description?: string | null;
  severity?: string;
  cursor?: string;
  schemaVersion?: string;
  scope?: {
    devices?: Record<string, any>[];
    applications?: Record<string, any>[];
    peers?: Record<string, any>[];
  };
  alertData?: Record<string, any>;
  [key: string]: any;
}
