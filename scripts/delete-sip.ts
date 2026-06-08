import { SipClient } from 'livekit-server-sdk';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
const sipClient = new SipClient(process.env.LIVEKIT_URL!, process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!);

async function run() {
  const existingTrunks = await sipClient.listSipInboundTrunk();
  for (const t of existingTrunks) {
    console.log(`Deleting Trunk ${t.sipTrunkId}`);
    await sipClient.deleteSipTrunk(t.sipTrunkId);
  }
  const existingRules = await sipClient.listSipDispatchRule();
  for (const r of existingRules) {
    console.log(`Deleting Rule ${r.sipDispatchRuleId}`);
    await sipClient.deleteSipDispatchRule(r.sipDispatchRuleId);
  }
}
run();
