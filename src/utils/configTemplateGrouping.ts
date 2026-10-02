/**
 * Redes vinculadas a una Configuration Template de Meraki (`isBoundToConfigTemplate`)
 * NO se pueden configurar una por una para webhooks: Meraki responde 400
 * "Cannot configure webhook urls on a bound network" en
 * POST /networks/{id}/webhooks/httpServers. La configuración vive en el
 * TEMPLATE, y las redes vinculadas la heredan.
 *
 * Verificado contra la API real (2-oct-2026): usando el id del Config Template
 * como si fuera una red, estos endpoints SÍ funcionan:
 *   POST/GET /networks/{templateId}/webhooks/payloadTemplates
 *   POST/GET /networks/{templateId}/webhooks/httpServers
 *   GET      /networks/{templateId}/alerts/settings
 * Por eso el resto del motor de aprovisionamiento no cambia: acá solo se
 * reemplazan las redes vinculadas por UNA "pseudo-red" por cada template.
 *
 * Esta función es pura (sin llamadas a Meraki ni a Mongo) a propósito, para
 * poder probarla con datos de mentira.
 */

export interface GroupableNetwork {
  id: string;
  name: string;
  organizationId: string;
  tags?: string[];
  isBoundToConfigTemplate?: boolean;
  configTemplateId?: string;
  // Solo en las pseudo-redes que representan a un Config Template:
  isConfigTemplate?: boolean;
  coveredNetworks?: number;
}

export interface TemplateGroupingResult<T extends GroupableNetwork> {
  // Redes NO vinculadas (tal cual llegaron) + una entrada por Config
  // Template, ordenadas de menor a mayor cantidad de redes cubiertas -- así,
  // un apply con networkSelector "all" procesa primero los templates chicos
  // y deja los grandes al final (mismo orden del plan de rollout gradual).
  pool: Array<T | GroupableNetwork>;
  // templateId -> ids de las redes vinculadas que cubre.
  coverage: Map<string, string[]>;
  // networkId (vinculada) -> templateId. Sirve para dar un mensaje útil si
  // alguien pide aprovisionar una red vinculada por su id.
  boundNetworkToTemplate: Map<string, string>;
  // Templates referenciados por alguna red pero que no aparecieron en la
  // lista de configTemplates de la organización (no debería pasar).
  unnamedTemplateIds: string[];
}

export function groupBoundNetworksByTemplate<T extends GroupableNetwork>(
  networks: T[],
  templateNames: Map<string, string>,
  organizationId: string,
): TemplateGroupingResult<T> {
  const unbound: T[] = [];
  const coverage = new Map<string, string[]>();
  const boundNetworkToTemplate = new Map<string, string>();

  for (const network of networks) {
    if (network.isBoundToConfigTemplate && network.configTemplateId) {
      const list = coverage.get(network.configTemplateId) ?? [];
      list.push(network.id);
      coverage.set(network.configTemplateId, list);
      boundNetworkToTemplate.set(network.id, network.configTemplateId);
    } else {
      unbound.push(network);
    }
  }

  const unnamedTemplateIds: string[] = [];
  const templatePseudoNetworks: GroupableNetwork[] = [...coverage.entries()]
    .map(([templateId, boundIds]) => {
      const name = templateNames.get(templateId);
      if (!name) unnamedTemplateIds.push(templateId);
      return {
        id: templateId,
        // Si el nombre no se pudo resolver, se usa el id: Meraki exige que el
        // nombre del payload template sea único en toda la organización, y el
        // id lo es.
        name: name ?? templateId,
        organizationId,
        tags: [],
        isConfigTemplate: true,
        coveredNetworks: boundIds.length,
      };
    })
    .sort((a, b) => (a.coveredNetworks ?? 0) - (b.coveredNetworks ?? 0) || a.name.localeCompare(b.name));

  return {
    pool: [...unbound, ...templatePseudoNetworks],
    coverage,
    boundNetworkToTemplate,
    unnamedTemplateIds,
  };
}
