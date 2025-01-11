import { Schema, model, Document } from "mongoose";
import { AlertSeverityHelixEnum } from "../enums/AlertSeverityEnum";

interface IAlarmManual extends Document {
  productType: string;
  categoryType: string;
  isActive: boolean;
  type: string;
  elementType: string;
  title: string;
  severityHelix:
    | AlertSeverityHelixEnum.ALTO
    | AlertSeverityHelixEnum.MEDIO
    | AlertSeverityHelixEnum.BAJO
    | AlertSeverityHelixEnum.CESE;
}

const alarmManualSchema = new Schema<IAlarmManual>({
  type: { type: String, required: true },
  productType: { type: String, required: true },
  categoryType: { type: String, required: true },
  isActive: { type: Boolean, required: true },
  elementType: { type: String, required: true },
  title: { type: String, required: true },
  severityHelix: { type: String, required: true },
});

const AlarmManual = model<IAlarmManual>("AlarmManual", alarmManualSchema);

export default AlarmManual;
