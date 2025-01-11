import axios from "axios";
import { handleError } from "../handlers/ErrorHandler";
import { ErrorCode } from "../enums/ErrorEnum";
import { INetworkGlpi } from "../interfaces/INetworkGlpiResponse";
import lodash from "lodash";

export const getSessionToken = async (): Promise<string> => {
  const url = process.env.URL_GLPI;
  const appToken = process.env.APP_TOKEN_GLPI;
  const Authorization = process.env.AUTHORIZATION_GLPI;

  try {
    const response = await axios.get(`http://${url}/initSession`, {
      headers: {
        Authorization: `user_token ${Authorization}`,
        "App-Token": appToken,
        "Content-Type": "application/json",
      },
    });
    const responseData: { session_token: string } = response.data;

    return responseData.session_token;
  } catch (error) {
    throw handleError(ErrorCode.E006);
  }
};

interface IResponseSearchNetworkId {
  totalcount: number;
  data: {
    "1": string;
    "2": number;
    "80": string;
  }[];
}

export const getNetworkId = async (
  nameDevice: string,
  sessionToken: string
): Promise<{ match: boolean; id: string }> => {
  const url = process.env.URL_GLPI;
  const appToken = process.env.APP_TOKEN_GLPI;
  let responseGetNetworkId = { match: false, id: "" };

  try {
    const response = await axios.get(`http://${url}/search/NetworkEquipment`, {
      headers: {
        "Session-Token": sessionToken,
        "App-Token": appToken,
        "Content-Type": "application/json",
      },
      params: {
        "criteria[0][field]": 1,
        "criteria[0][searchtype]": "contains",
        "criteria[0][value]": nameDevice,
        "forcedisplay[0]": 2,
      },
    });
    const responseData: IResponseSearchNetworkId = response.data;

    if (responseData.totalcount > 0) {
      if (lodash.get(responseData.data[0], "1", "") === nameDevice) {
        responseGetNetworkId = {
          match: true,
          id: responseData.data[0]["2"].toString(),
        };
      }
    }

    return responseGetNetworkId;
  } catch (error) {
    throw handleError(ErrorCode.E007);
  }
};

export const getNetworkData = async (
  networkId: string,
  sessionToken: string
): Promise<INetworkGlpi> => {
  const url = process.env.URL_GLPI;
  const appToken = process.env.APP_TOKEN_GLPI;

  try {
    const response = await axios.get(
      `http://${url}/NetworkEquipment/${networkId}`,
      {
        headers: {
          "Session-Token": sessionToken,
          "App-Token": appToken,
          "Content-Type": "application/json",
        },
      }
    );
    const responseData: INetworkGlpi = response.data;

    return responseData;
  } catch (error) {
    throw handleError(ErrorCode.E008);
  }
};
