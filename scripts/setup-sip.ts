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

    console.log('\n5. Creating WhatsApp Voice SIP Trunk...');
    let waTrunkId = '';
    const existingWaTrunks = existingTrunks.filter(t => t.name === 'Twilio WhatsApp Trunk');
    if (existingWaTrunks.length > 0) {
      console.log(`Found existing WhatsApp Trunk: ${existingWaTrunks[0].sipTrunkId}`);
      waTrunkId = existingWaTrunks[0].sipTrunkId;
    } else {
      const waTrunk = await sipClient.createSipInboundTrunk(
        'Twilio WhatsApp Trunk',
        ['+14155238886'], // Use allowedNumbers to avoid conflict with catch-all trunk
        { allowedAddresses: ['0.0.0.0/0'] }
      );
      console.log(`Created WhatsApp SIP Trunk: ${waTrunk.sipTrunkId}`);
      waTrunkId = waTrunk.sipTrunkId;
    }

    console.log('\n6. Creating WhatsApp Voice SIP Dispatch Rule...');
    const waRules = existingRules.filter(r => r.name === 'Route WhatsApp Voice Calls');
    if (waRules.length > 0) {
      console.log(`Found existing WhatsApp Dispatch Rule: ${waRules[0].sipDispatchRuleId}`);
    } else {
      const waRule = await sipClient.createSipDispatchRule(
        {
          type: 'individual',
          roomPrefix: 'wa-call-',
        },
        {
          name: 'Route WhatsApp Voice Calls',
          metadata: '{"tenantId":"default","channel":"whatsapp"}',
          trunkIds: [waTrunkId]
        }
      );
      console.log(`Created WhatsApp SIP Dispatch Rule: ${waRule.sipDispatchRuleId}`);
    }

    console.log('\n=========================================');
    console.log('SIP INTEGRATION SUCCESSFULLY PROVISIONED');
    console.log('=========================================');
    console.log('\nNext Steps in Twilio Console:');
    console.log('1. Go to Twilio -> Voice -> Manage -> SIP Domains');
    console.log('2. Create a new SIP Domain for your normal calls and point it to the main LiveKit SIP URI.');
    console.log(`3. Create ANOTHER SIP Domain for WhatsApp calls and point it to the LiveKit SIP URI for the new Twilio WhatsApp Trunk.`);
    console.log('4. Point your Twilio Phone numbers to route inbound calls to their respective SIP domains.');
    
  } catch (error) {
    console.error('Error setting up SIP:', error);
  }
}

setupSip();
