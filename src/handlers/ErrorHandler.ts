import { ErrorCode, ERRORS } from "../enums/ErrorEnum";

export function handleError(errorCode: ErrorCode, optionalId?: string) {
  const error = ERRORS[errorCode];
  if (optionalId) {
    console.error(
      `Error ${error.code}: ${error.message} con id: ${optionalId} (Status ${error.statusCode})`
    );
  } else {
    console.error(
      `Error ${error.code}: ${error.message} (Status ${error.statusCode})`
    );
  }
}
