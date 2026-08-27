import { ChannelImportSyncService } from './channel-import-sync';
import { getW3dsDatabase } from './db/client';

function maximumBatches(): number {
  const raw = Number.parseInt(process.env.CHANNEL_IMPORT_SYNC_BATCHES ?? '10', 10);
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, 100) : 10;
}

async function main(): Promise<void> {
  const service = new ChannelImportSyncService({ db: getW3dsDatabase() });
  let processed = 0;
  for (let index = 0; index < maximumBatches(); index += 1) {
    const result = await service.runNextBatch();
    if (result === 'disabled') {
      console.log('Channel import sync is disabled until provider configuration is complete.');
      return;
    }
    if (result === 'idle') break;
    processed += 1;
  }
  console.log(`Channel import sync processed ${processed} catalogue batches.`);
}

void main().catch(() => {
  console.error('Channel import sync stopped safely.');
  process.exitCode = 1;
});
