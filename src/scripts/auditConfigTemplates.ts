import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import connectDB from "../db/mongodb";
import WebhookProvisioningRun from "../models/WebhookProvisioningRun";
import { fetchMerakiPage, closeMerakiQueue, MerakiHttpResult } from "../queues/meraki.queue";

/**
 * AUDITORÍA DE SOLO LECTURA (Paso 1 del plan para las 332 redes fallidas del
 * rollout masivo -- ver memoria ms-helix-mep-webhook-findings-oct2026). Hace
 * únicamente GET contra Meraki y lecturas de Mongo; NO escribe nada en
 * ninguno de los dos.
 *
 * Qué hace:
 *  1. Lee de Mongo la corrida del rollout (por runId) y saca las redes con
 *     status "failed".
 *  2. Lista las redes de la organización en Meraki (con isBoundToConfigTemplate
 *     / configTemplateId) y agrupa las fallidas por Config Template. Las que no
 *     aparecen en Meraki se reportan aparte ("ya no existe").
 *  3. Para CADA Config Template involucrado lee su estado actual: receivers
 *     (webhooks/httpServers), cantidad de payload templates, y alerts/settings
 *     (defaultDestinations + qué tipos están habilitados y cuáles ya apuntan a
 *     un receiver).
 *  4. Imprime un resumen y deja el detalle completo en un JSON.
 *
 * IMPORTANTE -- este script NO levanta su propio Worker de `meraki-api-calls`
 * (a propósito, igual que backfillReconciliation.ts): usa el Worker del proceso
 * principal que ya corre en el contenedor, así se respeta el gateway único
 * (concurrency:1 + MERAKI_RATE_DELAY_MS). Por eso el contenedor tiene que estar
 * arriba. Con MERAKI_RATE_DELAY_MS=18000 son ~50 llamadas => ~15 min; con 300
 * son segundos.
 *
 * Uso (dentro del contenedor, ej. ms-helix-mep-wh):
 *   docker exec -d ms-helix-mep-wh sh -c "node build/scripts/auditConfigTemplates.js > /app/audit-templates.log 2>&1"
 *   docker exec ms-helix-mep-wh tail -f /app/audit-templates.log
 *
 * Variables opcionales:
 *   AUDIT_RUN_ID   runId de la corrida a auditar (default: la del rollout del 30-sep/1-oct).
 */

const ORG_ID = process.env.ORGANIZATION_ID || "";
const RUN_ID = process.env.AUDIT_RUN_ID || "e5d13622-b66a-43d4-9bb6-3ce862a2ef51";
const API_BASE = "https://api.meraki.com/api/v1";

interface OrgNetwork {
  id: string;
  name: string;
  isBoundToConfigTemplate?: boolean;
  configTemplateId?: string;
}

async function get(url: string): Promise<MerakiHttpResult> {
  const result = await fetchMerakiPage({ url, method: "GET" }, "audit-config-templates");
  if (!result) throw new Error(`Meraki no respondió a GET ${url}`);
  if (result.status < 200 || result.status >= 300) {
    const detail = Array.isArray(result.data?.errors) ? result.data.errors.join("; ") : "";
    throw new Error(`HTTP ${result.status} en GET ${url}${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

async function getAllPages<T>(url: string): Promise<T[]> {
  const rows: T[] = [];
  let next: string | null = url;
  while (next) {
    const r = await get(next);
    if (Array.isArray(r.data)) rows.push(...(r.data as T[]));
    const m = String(r.headers?.link ?? "").match(/<([^>]+)>;\s*rel=next/);
    next = m?.[1] ?? null;
  }
  return rows;
}

function summarizeAlertSettings(settings: any) {
  const dd = settings?.defaultDestinations ?? {};
  const alerts: any[] = Array.isArray(settings?.alerts) ? settings.alerts : [];
  const enabled = alerts.filter((a) => a?.enabled);
  const withReceiver = alerts.filter(
    (a) => Array.isArray(a?.alertDestinations?.httpServerIds) && a.alertDestinations.httpServerIds.length > 0,
  );
  return {
    defaultDestinations: {
      emails: Array.isArray(dd.emails) ? dd.emails.length : 0,
      snmp: !!dd.snmp,
      allAdmins: !!dd.allAdmins,
      httpServerIds: Array.isArray(dd.httpServerIds) ? dd.httpServerIds : [],
    },
    totalTypes: alerts.length,
    enabledTypes: enabled.map((a) => a.type),
    typesWithReceiver: withReceiver.map((a) => a.type),
  };
}

async function main() {
  console.log("=== Auditoría de Config Templates (SOLO LECTURA) ===");
  console.log(`organizationId=${ORG_ID}  runId=${RUN_ID}`);
  if (!ORG_ID || !process.env.TOKEN_CISCO) {
    console.error("Falta ORGANIZATION_ID o TOKEN_CISCO en el entorno.");
    process.exit(1);
  }

  await connectDB();
  const run = await WebhookProvisioningRun.findOne({ runId: RUN_ID }).lean();
  if (!run) {
    console.error(`No existe la corrida ${RUN_ID} en esta base de datos (¿es la instancia correcta?).`);
    process.exit(1);
  }
  const failed = run.networks.filter((n) => n.status === "failed");
  console.log(`\nCorrida encontrada: ${run.networksRequested} redes pedidas, ${failed.length} fallidas.`);

  const errorKinds = new Map<string, number>();
  for (const f of failed) {
    const key = (f.error ?? "sin detalle").replace(/\/networks\/[A-Za-z0-9_]+/g, "/networks/<id>").slice(0, 160);
    errorKinds.set(key, (errorKinds.get(key) ?? 0) + 1);
  }
  console.log("Errores de las fallidas (agrupados):");
  for (const [k, v] of errorKinds) console.log(`  ${v} x ${k}`);

  console.log("\nListando redes de la organización en Meraki...");
  const orgNetworks = await getAllPages<OrgNetwork>(`${API_BASE}/organizations/${ORG_ID}/networks?perPage=1000`);
  const byId = new Map(orgNetworks.map((n) => [n.id, n]));
  console.log(`  ${orgNetworks.length} redes en Meraki; ${orgNetworks.filter((n) => n.isBoundToConfigTemplate).length} vinculadas a un Config Template.`);

  const perTemplate = new Map<string, OrgNetwork[]>();
  const notFound: string[] = [];
  const failedNotBound: OrgNetwork[] = [];
  for (const f of failed) {
    const net = byId.get(f.networkId);
    if (!net) {
      notFound.push(`${f.networkId}  (${f.networkName})`);
      continue;
    }
    if (!net.isBoundToConfigTemplate || !net.configTemplateId) {
      failedNotBound.push(net);
      continue;
    }
    const list = perTemplate.get(net.configTemplateId) ?? [];
    list.push(net);
    perTemplate.set(net.configTemplateId, list);
  }

  console.log("\nListando Config Templates de la organización...");
  const templates = await getAllPages<{ id: string; name: string }>(`${API_BASE}/organizations/${ORG_ID}/configTemplates`);
  const templateName = new Map(templates.map((t) => [t.id, t.name]));

  const report: any = {
    runId: RUN_ID,
    generatedAt: new Date().toISOString(),
    failedTotal: failed.length,
    failedNotFoundInMeraki: notFound,
    failedNotBound: failedNotBound.map((n) => ({ id: n.id, name: n.name })),
    templates: [] as any[],
  };

  const ordered = [...perTemplate.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log(`\n${ordered.length} Config Templates involucrados. Leyendo la config actual de cada uno...\n`);

  for (const [templateId, nets] of ordered) {
    const entry: any = {
      templateId,
      templateName: templateName.get(templateId) ?? "(no aparece en configTemplates)",
      failedNetworks: nets.length,
      sampleNetworks: nets.slice(0, 3).map((n) => n.name),
    };
    try {
      const [servers, payloadTemplates, settings] = await Promise.all([
        get(`${API_BASE}/networks/${templateId}/webhooks/httpServers`),
        get(`${API_BASE}/networks/${templateId}/webhooks/payloadTemplates`),
        get(`${API_BASE}/networks/${templateId}/alerts/settings`),
      ]);
      entry.receivers = (Array.isArray(servers.data) ? servers.data : []).map((s: any) => ({
        id: s.id,
        name: s.name,
        url: s.url,
      }));
      entry.payloadTemplates = Array.isArray(payloadTemplates.data) ? payloadTemplates.data.length : 0;
      entry.alertSettings = summarizeAlertSettings(settings.data);
    } catch (e: any) {
      entry.error = e?.message ?? String(e);
    }
    report.templates.push(entry);

    const s = entry.alertSettings;
    console.log(`• ${entry.templateName}  [${templateId}]  -> ${nets.length} redes fallidas`);
    if (entry.error) {
      console.log(`    ERROR leyendo el template: ${entry.error}`);
      continue;
    }
    console.log(`    receivers: ${entry.receivers.length}${entry.receivers.length ? "  (" + entry.receivers.map((r: any) => r.name).join(", ") + ")" : ""}`);
    console.log(`    payload templates: ${entry.payloadTemplates}`);
    console.log(
      `    alert settings: ${s.enabledTypes.length}/${s.totalTypes} tipos habilitados` +
        `${s.enabledTypes.length ? " [" + s.enabledTypes.join(", ") + "]" : ""}`,
    );
    console.log(
      `    destino por defecto: emails=${s.defaultDestinations.emails} snmp=${s.defaultDestinations.snmp} ` +
        `allAdmins=${s.defaultDestinations.allAdmins} receivers=${s.defaultDestinations.httpServerIds.length}`,
    );
    console.log(`    tipos que YA apuntan a un receiver: ${s.typesWithReceiver.length}`);
  }

  console.log(`\nFallidas que ya NO existen en Meraki: ${notFound.length}`);
  notFound.forEach((n) => console.log(`  - ${n}`));
  console.log(`Fallidas que NO están vinculadas a template (revisar aparte): ${failedNotBound.length}`);
  failedNotBound.forEach((n) => console.log(`  - ${n.id}  (${n.name})`));

  const outDir = path.join(__dirname, "..", "..", "backfill-output");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `audit-config-templates_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), "utf-8");
  console.log(`\nDetalle completo guardado en: ${outFile}`);

  await closeMerakiQueue();
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("audit.fatal_error", err);
  process.exit(1);
});
