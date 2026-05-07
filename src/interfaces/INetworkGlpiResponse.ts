export interface INetworkGlpi {
  id: number;
  entities_id: string;
  is_recursive: number;
  name: string;
  ram: number | null;
  serial: string;
  otherserial: string;
  contact: string;
  contact_num: string;
  users_id_tech: string;
  groups_id_tech: string;
  date_mod: string;
  comment: string;
  locations_id: string;
  networks_id: number;
  networkequipmenttypes_id: string;
  networkequipmentmodels_id: string;
  manufacturers_id: string;
  is_deleted: number;
  is_template: number;
  template_name: string | null;
  users_id: number;
  groups_id: number;
  states_id: string;
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
