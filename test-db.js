const { createDbClient } = require('./packages/db-client/dist/index.js');
const db = createDbClient('postgresql://postgres:postgres@localhost:5432/voice_booking');
async function run() {
  const res = await db`SELECT id, config FROM tenants;`;
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
}
run();
