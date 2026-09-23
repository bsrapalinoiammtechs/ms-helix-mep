import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { log } from "../utils/logger";

/**
 * Valida el shared secret que Meraki manda DENTRO del body JSON del webhook
 * (`sharedSecret`), no como header -- así lo documenta Meraki
 * (developer.cisco.com/meraki/webhooks/introduction/). Mismo patrón
 * "fail closed" que `basicAuth.ts` (bull-board): si no hay
 * MERAKI_WEBHOOK_SHARED_SECRET configurado, se rechaza todo en vez de
 * dejar el endpoint abierto sin validar.
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

export function merakiWebhookAuth(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.MERAKI_WEBHOOK_SHARED_SECRET;

  if (!expected) {
    log.warn("meraki_webhook.auth.not_configured", {});
    return res
      .status(503)
      .json({ error: "Webhook deshabilitado: falta configurar MERAKI_WEBHOOK_SHARED_SECRET" });
  }

  const received = typeof req.body?.sharedSecret === "string" ? req.body.sharedSecret : "";

  if (!received || !timingSafeEqualStr(received, expected)) {
    log.warn("meraki_webhook.auth.failed", { ip: req.ip });
    return res.status(401).json({ error: "sharedSecret inválido" });
  }

  return next();
}
