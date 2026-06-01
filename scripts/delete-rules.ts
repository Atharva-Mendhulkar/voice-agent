import { SipClient } from 'livekit-server-sdk';
import dotenv from 'dotenv';
dotenv.config();

const sipClient = new SipClient(process.env.LIVEKIT_URL!, process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!);

async function run() {
  const rules = await sipClient.listSipDispatchRule();
  for (const r of rules) {
    console.log(`Deleting rule ${r.sipDispatchRuleId}`);
    await sipClient.deleteSipDispatchRule(r.sipDispatchRuleId!);
  }
}
run();
