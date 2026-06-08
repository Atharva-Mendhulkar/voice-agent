const { createDbClient } = require('./packages/db-client/dist/index.js');
const db = createDbClient('postgresql://postgres:postgres@localhost:5432/voice_booking');
async function run() {
  await db`UPDATE tenants SET config = config - 'calendarId' WHERE id = 'd3b07384-d113-4ec3-a558-e04e662e3f62';`;
  await db`UPDATE tenants SET config = config - 'calendarId' WHERE id = 'e9c80d24-39db-4841-9252-0c92fb3fe0e7';`;
  const res = await db`SELECT id, config FROM tenants;`;
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
}
run();
