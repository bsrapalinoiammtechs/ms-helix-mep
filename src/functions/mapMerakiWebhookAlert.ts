import { IAlertCisco } from "../interfaces/IAlertCisco";
import { MerakiWebhookAlertPayload } from "../interfaces/IMerakiWebhookAlert";

/**
 * Traduce el payload crudo de un webhook de Meraki al mismo formato interno
 * (`IAlertCisco`) que ya usa el flujo de polling (`active.alerts.service.ts`),
 * para reutilizar sin cambios el resto de la validación (catálogo, GLPI) y
 * el guardado en Mongo -- el webhook es solo una forma distinta de ENTERARSE
 * de la alerta, el resto del pipeline es el mismo.
 *
 * *** AJUSTAR ACÁ cuando se confirme el payload real de Meraki ***
 * Hoy es un mapeo best-effort basado en la documentación pública -- Meraki
 * describe `alertData` como "un objeto de parámetros únicos por cada tipo
 * de alerta", su forma exacta no está confirmada todavía para alertas de
 * conectividad/caída. Los campos marcados con TODO son los más propensos a
 * necesitar ajuste una vez se vea un payload real (vía "Send test" en el
 * Dashboard de Meraki, o una alerta real).
 */
export function mapMerakiWebhookAlert(raw: MerakiWebhookAlertPayload): IAlertCisco {
  const alertData = raw.alertData ?? {};
  const rawDevices = Array.isArray(raw.scope?.devices) ? raw.scope.devices : [];
  const firstRawDevice = rawDevices[0] ?? {};

  const deviceName: string =
    raw.deviceName ?? alertData.deviceName ?? alertData.name ?? firstRawDevice.name ?? "";
  const deviceMac: string =
    raw.deviceMac ?? alertData.deviceMac ?? alertData.mac ?? firstRawDevice.mac ?? "";
  const deviceSerial: string =
    raw.deviceSerial ?? alertData.deviceSerial ?? alertData.serial ?? firstRawDevice.serial ?? "";
  // TODO: confirmar el nombre real del campo -- puede venir como
  // `productType`, `deviceType`, o anidado en otro objeto dentro de
  // `alertData` según el tipo de alerta.
  const productType: string =
    alertData.productType ??
    alertData.deviceType ??
    firstRawDevice.productType ??
    raw.deviceType ??
    "";

  const devices = rawDevices.length > 0
    ? rawDevices.map((device, index) => ({
        url: device.url ?? "",
        name: device.name ?? "",
        productType: device.productType ?? productType,
        tags: Array.isArray(device.tags) ? device.tags : [],
        serial: device.serial ?? "",
        mac: device.mac ?? "",
        order: device.order ?? index,
      }))
    : [
        {
          url: alertData.deviceUrl ?? raw.deviceUrl ?? "",
          name: deviceName,
          productType,
          tags: raw.networkTags ?? [],
          serial: deviceSerial,
          mac: deviceMac,
          order: 0,
        },
      ];

  return {
    id: raw.alertId ?? "",
    // TODO: confirmar si `alertType` matchea 1:1 el `type` que usa hoy
    // CatalogService/AlarmManual (ese catálogo se llenó con los `type` que
    // trae la API de polling "Assurance Alerts" -- el nombre del tipo en
    // el webhook podría no ser idéntico).
    categoryType: raw.categoryType ?? raw.alertType ?? "",
    network: { id: raw.networkId ?? "", name: raw.networkName ?? "" },
    startedAt: raw.startedAt ?? raw.occurredAt ?? raw.sentAt ?? new Date().toISOString(),
    dismissedAt: raw.dismissedAt ?? null,
    // Este mapper es solo para alertas ACTIVAS (raised) -- el endpoint que
    // lo llama no recibe ceses todavía (ver FASE C, decisión pendiente).
    resolvedAt: raw.resolvedAt ?? null,
    expiresAt: raw.expiresAt ?? null,
    deviceType: productType,
    type: raw.alertType ?? "",
    title: raw.title ?? raw.alertType ?? "",
    // TODO: Meraki probablemente no manda una "description" de texto
    // libre igual que la API de polling -- ajustar con el payload real.
    description: raw.description ?? alertData.description ?? null,
    // TODO: severity no está confirmado en el payload del webhook.
    severity: raw.severity ?? alertData.severity ?? "",
    cursor: raw.cursor ?? "",
    scope: {
      devices,
      applications: Array.isArray(raw.scope?.applications) ? raw.scope.applications : [],
      peers: Array.isArray(raw.scope?.peers) ? raw.scope.peers : [],
    },
    schemaVersion: raw.schemaVersion ?? raw.version ?? "",
  };
}
