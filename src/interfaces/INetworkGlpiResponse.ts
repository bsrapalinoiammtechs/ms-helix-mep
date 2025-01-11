export interface INetworkGlpi {
  id: number;
  entities_id: number;
  is_recursive: number;
  name: string;
  ram: number;
  serial: string;
  otherserial: string;
  contact: string;
  contact_num: string;
  users_id_tech: number;
  groups_id_tech: number;
  date_mod: string;
  comment: string;
  locations_id: number;
  networks_id: number;
  networkequipmenttypes_id: number;
  networkequipmentmodels_id: number;
  manufacturers_id: number;
  is_deleted: number;
  is_template: number;
  template_name: string | null;
  users_id: number;
  groups_id: number;
  states_id: number;
  ticket_tco: number;
  is_dynamic: number;
  uuid: string;
  date_creation: string;
  autoupdatesystems_id: number;
  sysdescr: string;
  cpu: number;
  uptime: number;
  last_inventory_update?: string | null;
  snmpcredentials_id: number;
  links: ILinksGlpi[];
}

interface ILinksGlpi {
  rel: string;
  href: string;
}
