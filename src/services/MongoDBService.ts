import Alert from "../models/Alert";
import { IAlert } from "../interfaces/IAlert";
import { handleError } from "../handlers/ErrorHandler";
import { ErrorCode } from "../enums/ErrorEnum";
import AlarmManual from "../models/AlarmManual";
import { IAlarmManual } from "../interfaces/IAlarmManual";

export const saveAlert = async (alertToSave: IAlert) => {
  try {
    const existingAlert = await Alert.findOne({
      alertId: alertToSave.alertId,
    });

    if (existingAlert) {
      return existingAlert;
    } else {
      const savedAlert = await Alert.create(alertToSave);
      return savedAlert;
    }
  } catch (error) {
    console.log(error);
    throw handleError(ErrorCode.E002, alertToSave.alertId);
  }
};

export const getAlertsInGlpi = async (): Promise<IAlert[]> => {
  try {
    const alerts = await Alert.find({ isGlpi: true });

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
      { resolvedAt: resolvedAt },
      { new: true }
    );

    if (!updatedAlert) {
      throw new Error(`Aerta con ID ${alertId} no encontrado`);
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

export const updateCeseAlert = async (alertId: string) => {
  try {
    const updatedAlert = await Alert.findOneAndUpdate(
      { alertId },
      { isGlpi: false },
      { new: true }
    );

    if (!updatedAlert) {
      throw new Error(`Aerta con ID ${alertId} no encontrado`);
    }

    return updatedAlert;
  } catch (error) {
    throw handleError(ErrorCode.E009, alertId);
  }
};
