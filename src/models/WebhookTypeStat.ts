import { Schema, model, Document } from "mongoose";

export interface IWebhookTypeStat extends Document {
  alertType: string;
  productType: string;
  inCatalog: boolean;
  count: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastNetworkName: string;
  lastTitle: string;
  lastCategoryType: string;
}

const webhookTypeStatSchema = new Schema<IWebhookTypeStat>({
  alertType: { type: String, required: true },
  productType: { type: String, required: false, default: "" },
  inCatalog: { type: Boolean, required: true },
  count: { type: Number, required: true, default: 0 },
  firstSeenAt: { type: Date, required: true },
  lastSeenAt: { type: Date, required: true },
  lastNetworkName: { type: String, required: false, default: "" },
  lastTitle: { type: String, required: false, default: "" },
  lastCategoryType: { type: String, required: false, default: "" },
});

webhookTypeStatSchema.index({ alertType: 1, productType: 1 }, { unique: true });

const WebhookTypeStat = model<IWebhookTypeStat>("WebhookTypeStat", webhookTypeStatSchema);

export default WebhookTypeStat;
