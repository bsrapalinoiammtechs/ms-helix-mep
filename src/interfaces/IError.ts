import { StatusCodeEnum } from "../enums/ErrorEnum";

export interface AppError<T> {
    code: T; // Código de error, que será del tipo genérico (puede ser un enumerador como ErrorCode)
    message: string; // Mensaje de error
    statusCode: StatusCodeEnum; // Código de estado HTTP asociado al error
  }
  