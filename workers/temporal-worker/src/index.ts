import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { Worker } from '@temporalio/worker';
import { createDbClient } from '@voice-agent/db-client';
import { createRedisClient } from '@voice-agent/redis-client';
import * as activities from './activities/index.js';

// Try standard dotenv config first
dotenv.config();

// Also try loading from the root of the workspace if a key we expect isn't set
if (!process.env.DATABASE_URL && !process.env.SENDGRID_API_KEY) {
  const possiblePaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', '.env'),
    path.resolve(process.cwd(), '../..', '.env'),
    path.resolve(process.cwd(), '../../..', '.env'),
    path.resolve(__dirname, '.env'),
    path.resolve(__dirname, '..', '.env'),
    path.resolve(__dirname, '../..', '.env'),
    path.resolve(__dirname, '../../..', '.env'),
  ];
  for (const envPath of possiblePaths) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      break;
    }
  }
}

async function run() {
  const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/voice_booking';
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const temporalAddress = process.env.TEMPORAL_ADDRESS || 'localhost:7233';

  const db = createDbClient(dbUrl);
  const redis = createRedisClient(redisUrl);

  const boundActivities = activities.createActivities({ db, redis });

  console.log('Connecting worker to Temporal at:', temporalAddress);

  const { NativeConnection } = await import('@temporalio/worker');
  const connection = await NativeConnection.connect({
    address: temporalAddress,
  });

  const worker = await Worker.create({
    connection,
    workflowsPath: require.resolve('./workflows/index.js'),
    activities: boundActivities,
    taskQueue: 'booking-queue',
  });

  console.log('Temporal Worker successfully started. Listening on task queue "booking-queue"...');
  await worker.run();
}

run().catch((err) => {
  console.error('Fatal error in Temporal Worker run:', err);
  process.exit(1);
});
