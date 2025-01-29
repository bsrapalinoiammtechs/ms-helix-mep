export interface IAlert {
  alertId: string;
  organization: IOrganization;
  categoryType: string;
  network: INetwork;
  startedAt: string;
  dismissedAt: string | null;
  resolvedAt: string | null;
  deviceType: string;
  type: string;
  title: string;
  description: string;
  severity: string;
  scope: IScope;
  comment: string;
  descriptionGlpi: string;
  isGlpi: boolean;
  isTcp: boolean;
  location: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IOrganization {
  id: string;
  name: string;
}

export interface INetwork {
  id: string;
  name: string;
}

export interface IScope {
  devices: IDevice[];
}

export interface IDevice {
  url: string;
  name: string;
  productType: string;
  tags: string[];
  serial: string;
  mac: string;
}
