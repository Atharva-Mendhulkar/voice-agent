import dotenv from 'dotenv';
import { createDbClient, runMigrations } from '../packages/db-client/src/client.js';

dotenv.config();

async function run() {
  const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/voice_booking?schema=public';
  const db = createDbClient(DATABASE_URL);
  
  console.log('Running migrations...');
  try {
    await runMigrations(db);
    console.log('Migrations applied successfully!');
  } catch (err) {
    console.error('Failed to apply migrations', err);
  } finally {
    process.exit(0);
  }
}

run();
