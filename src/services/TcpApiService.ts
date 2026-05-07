import axios from "axios";
import { handleError } from "../handlers/ErrorHandler";
import { ErrorCode } from "../enums/ErrorEnum";
import { IAlertHelix } from "../interfaces/IAlertHelix";

export const sendAlertsToTcp = async (
  alertsToHelix: IAlertHelix[]
): Promise<any> => {
  const urlServerTcp = process.env.URL_TCP_SERVER;

  try {
    const response = await axios.post(
      `${urlServerTcp}/api/alerts`,
      alertsToHelix,
      {
      headers: {
        'Content-Type': 'application/json',
        'MS-Header': 'mep'
      }
    }
    );
    // console.log("resumen envio a tcp: ", alertsToHelix.map((a) => `${a.alertId}`))
    console.log(`TCP API: Enviando ${JSON.stringify(alertsToHelix.length)} alertas a TCP Server: `, new Date(Date.now()).toLocaleString('es-CO'));
    return response.data;
  } catch (error) {
    console.error(`TCP API: Error al enviar alertas a TCP Server: `, error);
    throw handleError(ErrorCode.E010);
  }
};
