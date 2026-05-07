import { IOrganization } from "./IAlert";

export interface IAlertHelix {
  tipo: string;
  idNotificacion: string;
  fechaHora: string;
  nombreEquipo: string;
  ipEquipo: string;
  causaEvento: string;
  evento: string;
  severidadEvento: string;
  descripcionEvento: string;
  nombreCliente: string;
  ubicacion: string;
  fase: string;
  alertId: string;
  organization: IOrganization;
}
