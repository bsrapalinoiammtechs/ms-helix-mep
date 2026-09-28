# Plan de aprovisionamiento de webhooks Meraki

## Objetivo

Automatizar el registro y la actualización de los siguientes elementos en los networks de una o varias organizaciones Meraki:

1. Liquid Payload Template.
2. HTTP Server o receiver.
3. Asociación entre el receiver y el template.
4. Alert settings que determinan cuáles alertas se envían al receiver.

La implementación debe permitir comenzar con una organización piloto o raíz, validar el resultado y después promover la misma configuración a otras organizaciones.

## Endpoints internos propuestos

```http
POST /admin/meraki/webhook-provisioning/preview
POST /admin/meraki/webhook-provisioning/apply
GET  /admin/meraki/webhook-provisioning/runs/:runId
```

### `preview`

Consulta Meraki y calcula las acciones necesarias, pero no realiza modificaciones.

### `apply`

Aplica el plan previamente validado. Debe crear o actualizar únicamente los elementos que lo necesiten.

### Consulta de ejecución

Permite revisar el avance y el resultado individual de cada network.

## Selectores de organizaciones

### Una organización

Útil para trabajar primero con la organización piloto o raíz.

```json
{
  "organizationSelector": {
    "mode": "organizationId",
    "id": "ORG_PRUEBAS"
  }
}
```

### Varias organizaciones específicas

```json
{
  "organizationSelector": {
    "mode": "organizationIds",
    "ids": [
      "ORG_MEP",
      "ORG_ADIFORT",
      "ORG_ACS2"
    ]
  }
}
```

### Todas las organizaciones accesibles

```json
{
  "organizationSelector": {
    "mode": "all"
  }
}
```

Este modo debe utilizarse únicamente después de validar la configuración en la organización piloto.

## Selectores de networks

### Todos los networks de las organizaciones seleccionadas

```json
{
  "networkSelector": {
    "mode": "all"
  }
}
```

### Networks específicos

```json
{
  "networkSelector": {
    "mode": "networkIds",
    "ids": [
      "L_NETWORK_1",
      "L_NETWORK_2"
    ]
  }
}
```

### Networks seleccionados por etiquetas

```json
{
  "networkSelector": {
    "mode": "tags",
    "tags": [
      "MonitoreoPBS"
    ]
  }
}
```

## Fuente de la configuración

### Configuración versionada en el proyecto

Esta debe ser la fuente principal para evitar que un cambio manual accidental se propague a todas las organizaciones.

```json
{
  "configurationSource": {
    "mode": "versioned",
    "version": "meraki-to-helix.v1"
  }
}
```

Archivos propuestos:

```text
config/webhooks/meraki-to-helix.v1.json
config/webhooks/meraki-to-helix.body.liquid
```

### Network de referencia

Permite leer la configuración de un network modelo de la organización raíz.

```json
{
  "configurationSource": {
    "mode": "referenceNetwork",
    "organizationId": "ORG_RAIZ",
    "networkId": "NETWORK_MODELO"
  }
}
```

Del network modelo se consultarían:

- Liquid Payload Template.
- Nombre y URL del receiver.
- Asociación entre template y receiver.
- Alert settings.
- Tipos de alerta habilitados.
- Destinos predeterminados.

Los identificadores `payloadTemplateId` y `httpServerId` del network modelo no deben copiarse. En cada network destino se debe crear o localizar el recurso equivalente y utilizar el ID correspondiente a ese network.

## Configuración del receiver

```json
{
  "configuration": {
    "version": "meraki-to-helix.v1",
    "templateName": "Meraki WebHook to Helix",
    "receiverName": "MEP Webhook",
    "receiverUrl": "https://pbscatalyst.ice.go.cr/webhooks/meraki/alerts",
    "secretSource": "MERAKI_WEBHOOK_SHARED_SECRET",
    "destinationMode": "default"
  }
}
```

El shared secret no debe enviarse en el request ni guardarse en los resultados. El backend debe obtenerlo de la variable de entorno indicada por `secretSource`.

## Modos de asociación con alertas

### Destino predeterminado

Agrega el receiver a `defaultDestinations.httpServerIds` conservando los destinos existentes.

```json
{
  "configuration": {
    "destinationMode": "default"
  }
}
```

### Tipos de alerta específicos

Agrega el receiver únicamente a los tipos seleccionados.

```json
{
  "configuration": {
    "destinationMode": "alertTypes",
    "alertTypes": [
      "client_connectivity",
      "power_supply_down"
    ]
  }
}
```

Los nombres exactos aceptados por Meraki deben verificarse contra la configuración y catálogo de alertas de cada network.

## Ejemplo: preview de la organización piloto

```json
{
  "organizationSelector": {
    "mode": "organizationId",
    "id": "ORG_PRUEBAS"
  },
  "networkSelector": {
    "mode": "all"
  },
  "configurationSource": {
    "mode": "versioned",
    "version": "meraki-to-helix.v1"
  },
  "configuration": {
    "templateName": "Meraki WebHook to Helix",
    "receiverName": "MEP Webhook",
    "receiverUrl": "https://pbscatalyst.ice.go.cr/webhooks/meraki/alerts",
    "secretSource": "MERAKI_WEBHOOK_SHARED_SECRET",
    "destinationMode": "default"
  },
  "execution": {
    "dryRun": true
  }
}
```

## Ejemplo: aplicar en la organización piloto

```json
{
  "organizationSelector": {
    "mode": "organizationId",
    "id": "ORG_PRUEBAS"
  },
  "networkSelector": {
    "mode": "all"
  },
  "configurationSource": {
    "mode": "versioned",
    "version": "meraki-to-helix.v1"
  },
  "configuration": {
    "templateName": "Meraki WebHook to Helix",
    "receiverName": "MEP Webhook",
    "receiverUrl": "https://pbscatalyst.ice.go.cr/webhooks/meraki/alerts",
    "secretSource": "MERAKI_WEBHOOK_SHARED_SECRET",
    "destinationMode": "default"
  },
  "execution": {
    "dryRun": false
  }
}
```

## Ejemplo: promover a organizaciones seleccionadas

```json
{
  "organizationSelector": {
    "mode": "organizationIds",
    "ids": [
      "ORG_MEP",
      "ORG_ADIFORT",
      "ORG_ACS2"
    ]
  },
  "networkSelector": {
    "mode": "all"
  },
  "configurationSource": {
    "mode": "versioned",
    "version": "meraki-to-helix.v1"
  },
  "configuration": {
    "templateName": "Meraki WebHook to Helix",
    "receiverName": "MEP Webhook",
    "receiverUrl": "https://pbscatalyst.ice.go.cr/webhooks/meraki/alerts",
    "secretSource": "MERAKI_WEBHOOK_SHARED_SECRET",
    "destinationMode": "default"
  },
  "execution": {
    "dryRun": true
  }
}
```

## Ejemplo: aplicar a todas las organizaciones

```json
{
  "organizationSelector": {
    "mode": "all"
  },
  "networkSelector": {
    "mode": "all"
  },
  "configurationSource": {
    "mode": "versioned",
    "version": "meraki-to-helix.v1"
  },
  "configuration": {
    "templateName": "Meraki WebHook to Helix",
    "receiverName": "MEP Webhook",
    "receiverUrl": "https://pbscatalyst.ice.go.cr/webhooks/meraki/alerts",
    "secretSource": "MERAKI_WEBHOOK_SHARED_SECRET",
    "destinationMode": "default"
  },
  "execution": {
    "dryRun": false
  }
}
```

## Respuesta propuesta para `preview`

```json
{
  "organizationCount": 1,
  "networksFound": 55,
  "summary": {
    "unchanged": 1,
    "templatesToCreate": 54,
    "templatesToUpdate": 0,
    "receiversToCreate": 54,
    "receiversToUpdate": 0,
    "alertSettingsToUpdate": 54
  },
  "networks": [
    {
      "organizationId": "ORG_PRUEBAS",
      "networkId": "L_NETWORK_1",
      "networkName": "Network de prueba",
      "templateAction": "create",
      "receiverAction": "create",
      "alertSettingsAction": "update"
    }
  ]
}
```

## Estados por network

Cada ejecución debe registrar uno de estos estados:

```text
created
updated
unchanged
failed
skipped
```

También debe guardar el error individual sin detener necesariamente el resto de networks.

## Reglas de seguridad e idempotencia

- `preview` nunca modifica Meraki.
- `apply` debe requerir autenticación administrativa.
- No devolver ni registrar API keys o shared secrets.
- Buscar templates por nombre administrado y comparar su contenido mediante un hash.
- Buscar receivers por nombre y URL.
- Crear recursos solamente cuando no existan.
- Actualizar solamente cuando haya diferencias.
- Conservar correos, SNMP, receivers y destinos existentes.
- No eliminar templates o receivers automáticamente en la primera versión.
- Utilizar la cola y el rate limit existentes para las llamadas a Meraki.
- Registrar cada ejecución y el resultado individual por network.
- Permitir reanudar una ejecución parcialmente fallida.

## Secuencia de implementación recomendada

1. Consulta de organizaciones y networks.
2. Implementación de `preview` sin escrituras.
3. Validación contra un network de la organización piloto.
4. Implementación de `apply` para un único network.
5. Aplicación a todos los networks de la organización piloto.
6. Habilitación del selector `organizationIds`.
7. Habilitación final del selector `all`.

