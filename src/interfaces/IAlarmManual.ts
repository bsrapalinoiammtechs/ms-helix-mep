import { AlertSeverityHelixEnum } from "../enums/AlertSeverityEnum";

export interface IAlarmManual {
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
