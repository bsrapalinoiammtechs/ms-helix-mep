import { Schema, model, Document } from "mongoose";

export interface IWebhookTest extends Document {
  source: "meraki_toolbox";
  queueJobId: string;
  organizationId: string;
  organizationName: string;
  networkId: string;
  networkName: string;
  alertType: string;
  productType: string;
  categoryType: string;
  title: string;
  startedAt: string;
  catalogMatched: boolean;
  payloadComplete: boolean;
  missingFields: string[];
  result: "catalog_matched" | "not_in_catalog";
}

const webhookTestSchema = new Schema<IWebhookTest>(
  {
    source: { type: String, required: true, default: "meraki_toolbox" },
    queueJobId: { type: String, required: true },
    organizationId: { type: String, required: false, default: "" },
    organizationName: { type: String, required: false, default: "" },
    networkId: { type: String, required: false, default: "" },
    networkName: { type: String, required: false, default: "" },
    alertType: { type: String, required: false, default: "" },
    productType: { type: String, required: false, default: "" },
    categoryType: { type: String, required: false, default: "" },
    title: { type: String, required: false, default: "" },
    startedAt: { type: String, required: false, default: "" },
    catalogMatched: { type: Boolean, required: true },
    payloadComplete: { type: Boolean, required: true },
    missingFields: { type: [String], required: true, default: [] },
    result: {
      type: String,
      required: true,
      enum: ["catalog_matched", "not_in_catalog"],
    },
  },
  { timestamps: true },
);

webhookTestSchema.index({ createdAt: -1 });
webhookTestSchema.index({ networkId: 1, createdAt: -1 });

const WebhookTest = model<IWebhookTest>("WebhookTest", webhookTestSchema);

export default WebhookTest;
