import { Schema, model, Document } from "mongoose";

export interface ISyncState extends Document {
  key: string;
  lastSyncAt: Date;
  lastPageCount: number;
  lastNewCount: number;
  lastPagesScanned: number;
  lastError?: string | null;
  metadata?: Record<string, unknown>;
}

const syncStateSchema = new Schema<ISyncState>(
  {
    key: { type: String, required: true, unique: true, index: true },
    lastSyncAt: { type: Date, required: true },
    lastPageCount: { type: Number, default: 0 },
    lastNewCount: { type: Number, default: 0 },
    lastPagesScanned: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

const SyncState = model<ISyncState>("SyncState", syncStateSchema);

export default SyncState;

export async function recordSync(
  key: string,
  fields: Partial<ISyncState>
): Promise<void> {
  try {
    await SyncState.findOneAndUpdate(
      { key },
      { $set: { ...fields, lastSyncAt: new Date() } },
      { upsert: true }
    );
  } catch {
    // best-effort: no debe fallar el flujo principal
  }
}

export async function getSyncState(key: string): Promise<ISyncState | null> {
  return SyncState.findOne({ key }).lean<ISyncState | null>();
}
