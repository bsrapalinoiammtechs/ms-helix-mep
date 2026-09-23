#!/usr/bin/env bash
# Simula un webhook de CESE (resolución) de Meraki contra el endpoint local.
# Uso: ./test-webhook-cese-local.sh <alertId>
# Si no pasás alertId, usa uno de ejemplo -- reemplazalo por uno real que
# ya hayas creado con test-webhook-local.sh para ver el ciclo completo
# (se crea como activa -> se resuelve acá).

ALERT_ID="${1:?Uso: ./test-webhook-cese-local.sh <alertId>}"

HOST="${WEBHOOK_TEST_HOST:-localhost}"
PORT="${WEBHOOK_TEST_PORT:-3005}"
SECRET="${MERAKI_WEBHOOK_SHARED_SECRET:-test-secret-local-123}"

curl -s -i -X POST "http://${HOST}:${PORT}/webhooks/meraki/ceses" \
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
  "alertId": "${ALERT_ID}",
  "alertType": "Connectivity"
}
PAYLOAD
