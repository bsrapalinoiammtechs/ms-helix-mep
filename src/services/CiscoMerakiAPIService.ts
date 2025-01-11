import axios from "axios";
import { handleError } from "../handlers/ErrorHandler";
import { ErrorCode } from "../enums/ErrorEnum";
import { IAlertCisco } from "../interfaces/IAlertCisco";

export const getListOfActiveAlerts = async (): Promise<IAlertCisco[]> => {
  const organizationId = process.env.ORGANIZATION_ID;
  const token = process.env.TOKEN_CISCO;

  try {
    const response = await axios.get(
      `https://api.meraki.com/api/v1/organizations/${organizationId}/assurance/alerts`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch {
    throw handleError(ErrorCode.E001);
  }
};

export const getListOfResolvedAlerts = async (): Promise<IAlertCisco[]> => {
  const organizationId = process.env.ORGANIZATION_ID;
  const token = process.env.TOKEN_CISCO;

  try {
    const response = await axios.get(
      `https://api.meraki.com/api/v1/organizations/${organizationId}/assurance/alerts`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        params: {
          //tsStart: "2024-12-13T04%3A13%3A02Z",
          //tsEnd: "2024-12-13T04%3A13%3A02Z",
          resolved: true,
          active: false,
          perPage: 300,
          //suppressAlertsForOfflineNodes: false,
          //sortBy: "severity",
          //sortOrder: "descending",
        },
      }
    );
    return response.data;
  } catch {
    throw handleError(ErrorCode.E005);
  }
};
