export interface IAlertCisco {
  id: string;
  categoryType: string;
  network: INetworkCisco;
  startedAt: string;
  dismissedAt: string | null;
  resolvedAt: string | null;
  expiresAt: string | null;
  deviceType: string;
  type: string;
  title: string;
  description: string | null;
  severity: string;
  cursor: string; //number
  scope: IScopeCisco;
  schemaVersion: string;
}

interface INetworkCisco {
  id: string;
  name: string;
}

interface IScopeCisco {
  devices: IDeviceCisco[];
  applications: any[];
  peers: any[];
}

interface IDeviceCisco {
  nodeId?: string | null;
  localeId?: number | null;
  url: string;
  name: string;
  productType: string;
  tags: string[];
  serial: string;
  mac: string;
  portIdentifier?: string | null;
  ethernetNegotiation?: IEthernetNegotiationCisco | null;
  lldpCdpPacket?: ILldpCdpPacketCisco | null;
  lldp?: ILldpCisco | null;
  order: number;
}

interface IEthernetNegotiationCisco {
  speed?: number | null;
  duplex?: string | null;
  negotiation?: string | null;
}

interface ILldpCdpPacketCisco {
  portId: string;
  chassisId: string;
  systemName: string;
  managementAddress: string;
  systemDescription: string;
  systemCapabilities: string;
}

interface ILldpCisco {
  portId: string;
}
