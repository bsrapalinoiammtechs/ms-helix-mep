import axios from "axios";
import { handleError } from "../handlers/ErrorHandler";
import { ErrorCode } from "../enums/ErrorEnum";
import { IAlertHelix } from "../interfaces/IAlertHelix";

export const sendAlertsToTcp = async (
  alertsToHelix: IAlertHelix[]
): Promise<any> => {
  const urlServerTcp = process.env.URL_TCP_SERVER;

  try {
    const response = await axios.post(`${urlServerTcp}/api/alerts`, {
      body: { alertsToHelix },
    });
    return response.data;
  } catch {
    throw handleError(ErrorCode.E010);
  }
};
