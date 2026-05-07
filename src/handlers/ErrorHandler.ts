import { ErrorCode, ERRORS } from "../enums/ErrorEnum";

export function handleError(errorCode: ErrorCode, optionalId?: string): Error {
  const error = ERRORS[errorCode];
  const mensaje = optionalId 
    ? `Error ${error.code}: ${error.message} con id: ${optionalId} (Status ${error.statusCode})`
    : `Error ${error.code}: ${error.message} (Status ${error.statusCode})`;
    
  console.error(mensaje);
  
  // Retornamos el error para que el 'throw' no lance undefined
  return new Error(mensaje);
}