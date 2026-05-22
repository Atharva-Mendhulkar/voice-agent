import { SipClient } from 'livekit-server-sdk';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load environment variables
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  console.error('.env file not found!');
  process.exit(1);
}

const livekitUrl = process.env.LIVEKIT_URL;
const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;

if (!livekitUrl || !apiKey || !apiSecret) {
  console.error('LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be set in .env');
  process.exit(1);
}

const sipClient = new SipClient(livekitUrl, apiKey, apiSecret);

async function setupSip() {
  try {
    console.log('1. Checking existing SIP Trunks...');
    const existingTrunks = await sipClient.listSipInboundTrunk();
    
    // Check if we already have one
    let trunkId = '';
    if (existingTrunks.length > 0) {
      console.log(`Found existing SIP Trunk: ${existingTrunks[0].sipTrunkId}`);
      trunkId = existingTrunks[0].sipTrunkId;
    } else {
      console.log('2. Creating a new SIP Inbound Trunk...');
      // To connect with Twilio, we generally do NOT want authentication (Twilio sends calls to us)
      const trunk = await sipClient.createSipInboundTrunk(
        'Twilio Inbound Trunk',
        [], // allow any incoming number
        {
          allowedAddresses: ['0.0.0.0/0'], // allow any incoming domain/address
        }
      );
      
      console.log(`Created SIP Trunk: ${trunk.sipTrunkId}`);
      trunkId = trunk.sipTrunkId;
    }

    console.log('\n3. Checking existing SIP Dispatch Rules...');
    const existingRules = await sipClient.listSipDispatchRule();
    
    if (existingRules.length > 0) {
      console.log(`Found existing SIP Dispatch Rule: ${existingRules[0].sipDispatchRuleId}`);
    } else {
      console.log('4. Creating a new SIP Dispatch Rule...');
      // Route incoming calls to a dynamically generated room named "sip-call-<random>"
      const rule = await sipClient.createSipDispatchRule(
        {
          type: 'individual',
          roomPrefix: 'sip-call-',
        },
        {
          name: 'Route to Dynamic Agent Room',
          metadata: '{"tenantId":"default"}',
        }
      );
      console.log(`Created SIP Dispatch Rule: ${rule.sipDispatchRuleId}`);
    }

    console.log('\n=========================================');
    console.log('SIP INTEGRATION SUCCESSFULLY PROVISIONED');
    console.log('=========================================');
    console.log('\nNext Steps in Twilio Console:');
    console.log('1. Go to Twilio -> Voice -> Manage -> SIP Domains');
    console.log('2. Create a new SIP Domain (e.g. voice-agent.sip.twilio.com)');
    console.log(`3. Copy the LiveKit SIP URI for your project from your LiveKit Cloud Dashboard and paste it into the Twilio Origination URI.`);
    console.log('4. Point your Twilio Phone number to route inbound calls to this SIP domain.');
    
  } catch (error) {
    console.error('Error setting up SIP:', error);
  }
}

setupSip();
