/**
 * Plantilla Meraki compatible con el mapper actual del receptor Helix.
 * Basada en el template "Meraki" publicado por Cisco; se mantiene
 * versionada para poder comparar y promover exactamente el mismo contenido.
 */
export const MERAKI_HELIX_TEMPLATE_VERSION = "meraki-to-helix.v1";
export const MERAKI_HELIX_TEMPLATE_NAME = "Meraki WebHook to Helix";

export const MERAKI_HELIX_TEMPLATE_BODY = `{
  "version": "0.1",
  "sharedSecret": "{{sharedSecret}}",
  "categoryType": "network",
  "networkId": "{{networkId}}",
  "networkName": "{{networkName}}",
  "startedAt": "{{occurredAt}}",
  "dismissedAt": null,
  "resolvedAt": null,
  "expiresAt": null,
  "deviceType": "{% if deviceModel contains 'MX' or deviceModel contains 'Z3' or deviceModel contains 'Z4' %}appliance{% elsif deviceModel contains 'MR' or deviceModel contains 'CW' %}wireless{% elsif deviceModel contains 'MS' %}switch{% elsif deviceModel contains 'MV' %}camera{% elsif deviceModel contains 'MG' %}cellularGateway{% else %}unknown{% endif %}",
  "alertType": "{{alertTypeId}}",
  "title": "{{alertType}}",
  "description": null,
  "severity": "{{alertLevel}}",
  "cursor": "{{sentAt}}",
  "organizationId": "{{organizationId}}",
  "organizationName": "{{organizationName}}",
  "organizationUrl": "{{organizationUrl}}",
  "alertId": "{{alertId}}",
  "scope": {
    "devices": [
      {
        "nodeId": null,
        "localeId": null,
        "url": "{{deviceUrl}}",
        "name": "{{deviceName}}",
        "productType": "{% if deviceModel contains 'MX' or deviceModel contains 'Z3' or deviceModel contains 'Z4' %}appliance{% elsif deviceModel contains 'MR' or deviceModel contains 'CW' %}wireless{% elsif deviceModel contains 'MS' %}switch{% elsif deviceModel contains 'MV' %}camera{% elsif deviceModel contains 'MG' %}cellularGateway{% else %}unknown{% endif %}",
        "tags": {{ deviceTags | jsonify }},
        "serial": "{{deviceSerial}}",
        "mac": "{{deviceMac}}",
        "portIdentifier": null,
        "ethernetNegotiation": null,
        "lldpCdpPacket": null,
        "lldp": null,
        "order": 0
      }
    ],
    "applications": [],
    "peers": []
  },
  "schemaVersion": "1"
}`;

export const MERAKI_HELIX_TEMPLATE_HEADERS: Array<{
  name: string;
  template: string;
}> = [];

