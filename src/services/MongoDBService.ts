import Alert from "../models/Alert";
import { IAlert } from "../interfaces/IAlert";
import { handleError } from "../handlers/ErrorHandler";
import { ErrorCode } from "../enums/ErrorEnum";
import AlarmManual from "../models/AlarmManual";
import { IAlarmManual } from "../interfaces/IAlarmManual";
import { log } from "../utils/logger";

export const saveAlert = async (alertToSave: IAlert) => {
  try {
    const updated = await Alert.findOneAndUpdate(
      { alertId: alertToSave.alertId },
      {
        $set: {
          startedAt: alertToSave.startedAt,
          dismissedAt: alertToSave.dismissedAt,
          resolvedAt: alertToSave.resolvedAt,
          scope: alertToSave.scope,
          title: alertToSave.title,
          description: alertToSave.description,
          comment: alertToSave.comment,
          location: alertToSave.location,
          descriptionGlpi: alertToSave.descriptionGlpi,
          severity: alertToSave.severity,
          network: alertToSave.network,
          deviceType: alertToSave.deviceType,
          categoryType: alertToSave.categoryType,
        },
        $setOnInsert: {
          alertId: alertToSave.alertId,
          organization: alertToSave.organization,
          type: alertToSave.type,
          isGlpi: alertToSave.isGlpi,
          isTcp: false,
        },
      },
      { new: true, upsert: true }
    );
    return updated;
  } catch (error) {
    console.log(error);
    throw handleError(ErrorCode.E002, alertToSave.alertId);
  }
};

export const handleReactivation = async (
  alertId: string,
  newStartedAt?: string
) => {
  try {
    const updateOps: Record<string, unknown> = { resolvedAt: null, isTcp: false };
    if (newStartedAt) updateOps.startedAt = newStartedAt;
    const reactivated = await Alert.findOneAndUpdate(
      { alertId, resolvedAt: { $ne: null } },
      { $set: updateOps },
      { new: true }
    );
    if (reactivated) {
      log.info("alert.reactivated", { alertId });
    }
    return reactivated;
  } catch (error) {
    log.error("alert.reactivate.error", { alertId, message: (error as Error)?.message });
    return null;
  }
};

/**
 * Devuelve los alertId que ya están en MEP DB con resolvedAt:null (vivos).
 * Usado por el sync incremental: si todos los IDs de una página de Cisco
 * ya están aquí como activos, no hay nada nuevo y se puede cortar la paginación.
 */
export const getExistingActiveAlertIds = async (
  ids: string[]
): Promise<Set<string>> => {
  if (ids.length === 0) return new Set();
  const docs = await Alert.find(
    { alertId: { $in: ids }, resolvedAt: null },
    { alertId: 1, _id: 0 }
  ).lean<{ alertId: string }[]>();
  return new Set(docs.map((d) => d.alertId));
};

/**
 * Devuelve los alertId que ya están en MEP DB con resolvedAt!=null (cesados).
 * Usado por el sync incremental de CESE.
 */
export const getExistingCesedAlertIds = async (
  ids: string[]
): Promise<Set<string>> => {
  if (ids.length === 0) return new Set();
  const docs = await Alert.find(
    { alertId: { $in: ids }, resolvedAt: { $ne: null } },
    { alertId: 1, _id: 0 }
  ).lean<{ alertId: string }[]>();
  return new Set(docs.map((d) => d.alertId));
};

export const getAlertsInGlpi = async (): Promise<IAlert[]> => {
  try {
    const alerts = await Alert.find({ isGlpi: true });
    return alerts;
  } catch (error) {
    throw handleError(ErrorCode.E003);
  }
};

export const getPendingAlertsForSend = async (limit = 1000): Promise<IAlert[]> => {
  try {
    const alerts = await Alert.find({ isGlpi: true, isTcp: false })
      .sort({ updatedAt: 1 })
      .limit(limit)
      .lean<IAlert[]>();
    return alerts;
  } catch (error) {
    throw handleError(ErrorCode.E003);
  }
};

export const updateAlertResolved = async (
  alertId: string,
  resolvedAt: string
) => {
  try {
    const updatedAlert = await Alert.findOneAndUpdate(
      { alertId },
      { $set: { resolvedAt: resolvedAt, isTcp: false } },
      { new: true }
    );

    if (!updatedAlert) {
      throw new Error(`Alerta con ID ${alertId} no encontrado`);
    }

    return updatedAlert;
  } catch (error) {
    throw handleError(ErrorCode.E004, alertId);
  }
};

export const getAlarmsManual = async (
  type: string,
  productType: string
): Promise<IAlarmManual[]> => {
  try {
    const alarmsManual = await AlarmManual.find({
      type: type,
      isActive: true,
      productType: productType,
    });

    return alarmsManual;
  } catch (error) {
    throw handleError(ErrorCode.E012);
  }
};

/**
 * Marca isTcp=true sólo si la alerta sigue exactamente en el estado en que el
 * cron la leyó (mismo resolvedAt). Si entre lectura y envío otro proceso cambió
 * resolvedAt (por ejemplo, CESE service la cesó), retorna null y el cron debe
 * tratar el envío como NO confirmado: la alerta seguirá con isTcp=false y el
 * próximo ciclo la recogerá con su nuevo estado.
 */
export const setIsTCpAlert = async (
  alertId: string,
  expectedResolvedAt?: string | null
) => {
  try {
    const filter: Record<string, unknown> = { alertId, isTcp: false };
    if (expectedResolvedAt === undefined) {
      // legacy: sin verificación. Sólo para callers que no aplican Fase 3.
    } else {
      filter.resolvedAt = expectedResolvedAt;
    }
    const updatedAlert = await Alert.findOneAndUpdate(
      filter,
      { $set: { isTcp: true, sentAt: new Date() } },
      { new: true }
    );

    if (!updatedAlert) {
      log.warn("alert.claim.lost", { alertId, expectedResolvedAt });
      return null;
    }

    return updatedAlert;
  } catch (error) {
    throw handleError(ErrorCode.E013, alertId);
  }
};
