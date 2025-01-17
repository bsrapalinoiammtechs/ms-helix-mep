import { AppError } from "../interfaces/IError";

export enum ErrorCode {
  E001 = "E001",
  E002 = "E002",
  E003 = "E003",
  E004 = "E004",
  E005 = "E005",
  E006 = "E006",
  E007 = "E007",
  E008 = "E008",
  E009 = "E009",
  E010 = "E010",
  E011 = "E011",
  E012 = "E012",
  E013 = "E013",
  E088 = "EO88",
}

export enum StatusCodeEnum {
  OK = 200,
  BadRequest = 400,
  InternalServerError = 500,
}

export const ERRORS: Record<ErrorCode, AppError<ErrorCode>> = {
  [ErrorCode.E001]: {
    code: ErrorCode.E001,
    message: "Error al obtener las alertas activas de la api de cisco.",
    statusCode: StatusCodeEnum.BadRequest,
  },
  [ErrorCode.E002]: {
    code: ErrorCode.E002,
    message: "Error al guardar la alerta en la base de datos.",
    statusCode: StatusCodeEnum.BadRequest,
  },
  [ErrorCode.E003]: {
    code: ErrorCode.E003,
    message: "Error al obtener las alertas activas de la base de datos.",
    statusCode: StatusCodeEnum.BadRequest,
  },
  [ErrorCode.E004]: {
    code: ErrorCode.E004,
    message: "Error al actualizar una alerta resuelta.",
    statusCode: StatusCodeEnum.BadRequest,
  },
  [ErrorCode.E005]: {
    code: ErrorCode.E005,
    message: "Error al obtener las alertas resueltas de la api de cisco.",
    statusCode: StatusCodeEnum.BadRequest,
  },
  [ErrorCode.E006]: {
    code: ErrorCode.E006,
    message: "Error al obtener el session_token de Glpi.",
    statusCode: StatusCodeEnum.BadRequest,
  },
  [ErrorCode.E007]: {
    code: ErrorCode.E007,
    message:
      "Error al obtener el id de la network por nombre del dispositivo de Glpi.",
    statusCode: StatusCodeEnum.BadRequest,
  },
  [ErrorCode.E008]: {
    code: ErrorCode.E008,
    message: "Error al obtener la network por id de Glpi.",
    statusCode: StatusCodeEnum.BadRequest,
  },
  [ErrorCode.E009]: {
    code: ErrorCode.E009,
    message: "Error al inactivar una alerta en Cese en la base de datos.",
    statusCode: StatusCodeEnum.BadRequest,
  },
  [ErrorCode.E010]: {
    code: ErrorCode.E010,
    message: "Error al enviar las alertas activas al servidor TCP.",
    statusCode: StatusCodeEnum.BadRequest,
  },
  [ErrorCode.E011]: {
    code: ErrorCode.E011,
    message: "",
    statusCode: StatusCodeEnum.BadRequest,
  },
  [ErrorCode.E012]: {
    code: ErrorCode.E012,
    message: "Hubo un error y no fue posible obtener el manual de alarmas",
    statusCode: StatusCodeEnum.BadRequest,
  },
  [ErrorCode.E013]: {
    code: ErrorCode.E013,
    message: "Error al actualizar isTcp en una alerta.",
    statusCode: StatusCodeEnum.BadRequest,
  },
  [ErrorCode.E088]: {
    code: ErrorCode.E088,
    message: "Recurso no encontrado.",
    statusCode: StatusCodeEnum.InternalServerError,
  },
  // Añade más errores según sea necesario
};
