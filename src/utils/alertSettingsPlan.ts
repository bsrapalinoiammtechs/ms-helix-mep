/**
 * Lógica pura (sin llamadas a Meraki) del modo destinationMode:"alertTypes"
 * del aprovisionamiento de webhooks -- separada del servicio a propósito para
 * poder probarla con datos de mentira, sin Redis/Mongo.
 *
 * Contexto de enableAlertTypes: los Config Templates de MEP están en blanco
 * (solo `ampMalwareDetected` habilitado, defaultDestinations con
 * allAdmins:true). Asociar el receiver a un tipo DESHABILITADO no genera
 * ninguna alerta, así que hay que habilitarlo. Pero habilitarlo con los
 * destinos por defecto mandaría también correo a todos los administradores
 * (allAdmins:true), por eso los tipos recién habilitados quedan con destino
 * aislado: solo el receiver, sin correos, sin SNMP, allAdmins:false.
 */

export interface AlertDestinationsLike {
  emails?: string[];
  snmp?: boolean;
  httpServerIds?: string[];
  allAdmins?: boolean;
  [key: string]: any;
}

export interface AlertTypeSettingLike {
  type: string;
  enabled?: boolean;
  alertDestinations?: AlertDestinationsLike;
  [key: string]: any;
}

export interface AlertsSettingsLike {
  defaultDestinations?: AlertDestinationsLike;
  alerts?: AlertTypeSettingLike[];
  [key: string]: any;
}

export interface AlertTypesEvaluation {
  // Tipos pedidos que existen en el catálogo de esta red/template.
  validTypes: string[];
  // Tipos pedidos que NO existen en el catálogo (informativo).
  missingTypes: string[];
  // Solo con enable:true: tipos válidos hoy deshabilitados que se van a habilitar.
  toEnable: string[];
  // true si ya está todo como se pide (receiver asociado y, con enable, habilitado).
  satisfied: boolean;
}

export function evaluateAlertTypes(
  settings: AlertsSettingsLike,
  receiverId: string | undefined,
  alertTypes: string[],
  enable: boolean,
): AlertTypesEvaluation {
  const alerts = settings.alerts ?? [];
  const catalog = new Set(alerts.map((alert) => alert.type));
  const validTypes = alertTypes.filter((type) => catalog.has(type));
  const missingTypes = alertTypes.filter((type) => !catalog.has(type));
  const selected = alerts.filter((alert) => validTypes.includes(alert.type));
  const toEnable = enable ? selected.filter((alert) => alert.enabled !== true).map((alert) => alert.type) : [];
  const satisfied =
    !!receiverId &&
    toEnable.length === 0 &&
    selected.every((alert) => (alert.alertDestinations?.httpServerIds ?? []).includes(receiverId));
  return { validTypes, missingTypes, toEnable, satisfied };
}

export function buildAlertTypesBody(
  current: AlertsSettingsLike,
  receiverId: string,
  alertTypes: string[],
  enable: boolean,
): AlertsSettingsLike {
  return {
    ...current,
    // "alertTypes" significa SOLO estos tipos -- si el receiver ya estaba en
    // defaultDestinations (p.ej. de un rollout previo en modo "default"),
    // hay que sacarlo de ahí o seguiría recibiendo TODOS los tipos
    // habilitados además de los elegidos acá.
    defaultDestinations: {
      ...current.defaultDestinations,
      httpServerIds: (current.defaultDestinations?.httpServerIds ?? []).filter((id) => id !== receiverId),
    },
    alerts: (current.alerts ?? []).map((alert) => {
      if (!alertTypes.includes(alert.type)) return alert;
      const existingIds = alert.alertDestinations?.httpServerIds ?? [];
      const withReceiver = existingIds.includes(receiverId) ? existingIds : [...existingIds, receiverId];
      if (enable && alert.enabled !== true) {
        // Recién habilitado: destino aislado (ver comentario del archivo).
        return {
          ...alert,
          enabled: true,
          alertDestinations: {
            ...alert.alertDestinations,
            emails: [],
            snmp: false,
            allAdmins: false,
            httpServerIds: withReceiver,
          },
        };
      }
      return {
        ...alert,
        alertDestinations: { ...alert.alertDestinations, httpServerIds: withReceiver },
      };
    }),
  };
}
