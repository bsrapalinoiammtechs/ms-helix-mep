import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { log } from "../utils/logger";

/**
 * Basic auth mínimo para proteger /admin/queues (bull-board). Diseño
 * "fail closed": si BULLBOARD_USER/BULLBOARD_PASSWORD no están seteadas en
 * el entorno, la ruta responde 503 en vez de quedar abierta sin auth. No
 * hardcodear un usuario/clave por defecto acá -- este archivo se sube a
 * git (igual que el resto del repo) y no queremos un secreto real en el
 * historial.
 */

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Comparación dummy para no filtrar por timing que la longitud no matchea.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function bullBoardBasicAuth(req: Request, res: Response, next: NextFunction) {
  const expectedUser = process.env.BULLBOARD_USER;
  const expectedPass = process.env.BULLBOARD_PASSWORD;

  if (!expectedUser || !expectedPass) {
    log.warn("bullboard.auth.not_configured", {});
    return res
      .status(503)
      .send("Bull-board deshabilitado: falta configurar BULLBOARD_USER/BULLBOARD_PASSWORD");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="ms-helix-mep admin"');
    return res.status(401).send("Autenticación requerida");
  }

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const sepIdx = decoded.indexOf(":");
  const reqUser = sepIdx >= 0 ? decoded.slice(0, sepIdx) : decoded;
  const reqPass = sepIdx >= 0 ? decoded.slice(sepIdx + 1) : "";

  const userOk = timingSafeEqualStr(reqUser, expectedUser);
  const passOk = timingSafeEqualStr(reqPass, expectedPass);

  if (!userOk || !passOk) {
    log.warn("bullboard.auth.failed", { user: reqUser });
    res.set("WWW-Authenticate", 'Basic realm="ms-helix-mep admin"');
    return res.status(401).send("Credenciales inválidas");
  }

  return next();
}
