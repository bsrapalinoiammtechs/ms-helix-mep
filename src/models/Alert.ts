import { Schema, model, Document } from "mongoose";
import { INetwork, IScope, IDevice, IOrganization } from "../interfaces/IAlert";

interface IAlert extends Document {
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
  createdAt?: Date;
  updatedAt?: Date;
}

const organizationSchema = new Schema<IOrganization>(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
  },
  { _id: false }
);

const networkSchema = new Schema<INetwork>(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
  },
  { _id: false }
);

const deviceSchema = new Schema<IDevice>(
  {
    url: { type: String, required: true },
    name: { type: String, required: false },
    productType: { type: String, required: true },
    tags: { type: [String], required: false },
    serial: { type: String, required: false },
    mac: { type: String, required: false },
  },
  { _id: false }
);

const scopeSchema = new Schema<IScope>(
  {
    devices: { type: [deviceSchema], required: true },
  },
  { _id: false }
);

const alertSchema = new Schema<IAlert>(
  {
    alertId: { type: String, required: true, unique: true },
    organization: { type: organizationSchema, required: true },
    categoryType: { type: String, required: true },
    network: { type: networkSchema, required: true },
    startedAt: { type: String, required: true },
    dismissedAt: { type: String, required: false },
    resolvedAt: { type: String, required: false },
    deviceType: { type: String, required: true },
    type: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, required: false },
    severity: { type: String, required: true },
    scope: { type: scopeSchema, required: true },
    comment: { type: String, required: false },
    descriptionGlpi: { type: String, required: false },
    isGlpi: { type: Boolean, required: true },
    isTcp: { type: Boolean, required: true, default: false },
  },
  { timestamps: true } // Habilita `createdAt` y `updatedAt`
);

const Alert = model<IAlert>("Alert", alertSchema);

export default Alert;
