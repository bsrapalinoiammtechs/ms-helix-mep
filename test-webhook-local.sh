#!/usr/bin/env bash
# Simula un webhook de Meraki contra el endpoint local -- no necesita
# dominio público ni que Meraki exista de verdad, prueba solo nuestro
# pipeline (auth -> cola -> worker -> catálogo -> GLPI -> Mongo).

HOST="${WEBHOOK_TEST_HOST:-localhost}"
PORT="${WEBHOOK_TEST_PORT:-3005}"
SECRET="${MERAKI_WEBHOOK_SHARED_SECRET:-test-secret-local-123}"

# Ajustá "alertType" y "productType" a un par que SÍ exista en tu catálogo
# (AlarmManual, isActive:true) -- si no matchea ninguna regla, el worker lo
# descarta igual (verás "not_in_catalog" en el log), lo cual sirve para
# probar el resto del flujo, pero no vas a ver la alerta guardada en Mongo.
curl -s -i -X POST "http://${HOST}:${PORT}/webhooks/meraki/alerts" \
  -H "Content-Type: application/json" \
  -d @- << PAYLOAD
{
  "version": "0.1",
  "sharedSecret": "${SECRET}",
  "sentAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "occurredAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "organizationId": "${ORGANIZATION_ID:-846353}",
  "organizationName": "MEP",
  "networkId": "L_3865777330144150701",
  "networkName": "Red de prueba",
  "networkTags": [],
  "alertId": "test-$(date +%s)",
  "alertType": "Connectivity",
  "alertData": {
    "deviceName": "SAMEP-TEST-DEVICE",
    "deviceMac": "00:11:22:33:44:55",
    "deviceSerial": "Q3AK-TEST-0001",
    "productType": "wireless",
    "severity": "critical",
    "description": "Prueba local de webhook"
  }
}
PAYLOAD
