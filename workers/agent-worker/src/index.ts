import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { createRedisClient } from '@voice-agent/redis-client';
import { createDbClient } from '@voice-agent/db-client';
import { Connection, Client as TemporalClient } from '@temporalio/client';
import { cli, WorkerOptions } from '@livekit/agents';
dotenv.config();

// Also try loading from the root of the workspace if a key we expect isn't set
if (!process.env.DATABASE_URL && !process.env.DEEPGRAM_API_KEY) {
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

async function main() {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/voice_booking';
  const temporalAddress = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  const temporalNamespace = process.env.TEMPORAL_NAMESPACE || 'default';

  console.log('Initializing databases...');
  const redis = createRedisClient(redisUrl);
  const db = createDbClient(dbUrl);

  console.log('Connecting to Temporal...');
  const temporalConnection = await Connection.connect({ address: temporalAddress });
  const temporal = new TemporalClient({
    connection: temporalConnection,
    namespace: temporalNamespace,
  });

  // Attach these globally so the agent entry can access them
  (global as any).redis = redis;
  (global as any).db = db;
  (global as any).temporal = temporal;

  console.log('Agent worker starting LiveKit worker...');

  await cli.runApp(
    new WorkerOptions({
      agent: path.resolve(__dirname, 'bookingAgent.js'),
      agentName: process.env.LIVEKIT_AGENT_NAME || 'voice-agent',
    })
  );

  console.log('Agent worker successfully booted.');
  
  process.on('SIGTERM', () => {
    console.log('SIGTERM received. Starting graceful shutdown and session draining...');
    setTimeout(() => {
      console.log('Graceful draining window completed. Shutting down worker...');
      process.exit(0);
    }, 5000);
  });
}

main().catch((err) => {
  console.error('Fatal error in agent worker bootstrap:', err);
  process.exit(1);
});
