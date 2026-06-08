import { SipClient } from 'livekit-server-sdk';
import { RoomAgentDispatch, RoomConfiguration, SIPHeaderOptions } from '@livekit/protocol';
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
const agentName = process.env.LIVEKIT_AGENT_NAME || 'voice-agent';
const defaultTenantId = process.env.TWILIO_DEFAULT_TENANT_ID || process.env.DEFAULT_TENANT_ID;
const pstnNumbers = (process.env.TWILIO_PSTN_NUMBERS || '')
  .split(',')
  .flatMap((num) => {
    const clean = num.trim().replace('+', '');
    return [`+${clean}`, clean];
  })
  .filter(Boolean);
const rawWhatsAppNumber = process.env.TWILIO_WHATSAPP_FROM || '';
const cleanWa = rawWhatsAppNumber.replace(/^whatsapp:/, '').replace('+', '');
const whatsAppNumber = cleanWa ? [`+${cleanWa}`, cleanWa] : [];

if (!livekitUrl || !apiKey || !apiSecret) {
  console.error('LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be set in .env');
  process.exit(1);
}

if (!defaultTenantId) {
  console.error('TWILIO_DEFAULT_TENANT_ID or DEFAULT_TENANT_ID must be set to a valid tenant UUID.');
  process.exit(1);
}

if (!whatsAppNumber) {
  console.error('TWILIO_WHATSAPP_FROM must be set to the WhatsApp sender phone number, e.g. whatsapp:+14155238886.');
  process.exit(1);
}

const sipClient = new SipClient(livekitUrl, apiKey, apiSecret);

function roomConfigFor(channel: 'pstn_twilio' | 'whatsapp') {
  const metadata = JSON.stringify({ tenantId: defaultTenantId, channel });
  return {
    metadata,
    roomConfig: new RoomConfiguration({
      metadata,
      agents: [
        new RoomAgentDispatch({
          agentName,
          metadata,
        }),
      ],
    }),
  };
}

async function setupSip() {
  try {
    console.log('1. Checking existing SIP Trunks...');
    const existingTrunks = await sipClient.listSipInboundTrunk();
    
    // Check if we already have one
    let trunkId = '';
    const existingPstnTrunk = existingTrunks.find(t => t.name === 'Twilio Inbound Trunk');
    if (existingPstnTrunk) {
      console.log(`Found existing SIP Trunk: ${existingPstnTrunk.sipTrunkId}`);
      trunkId = existingPstnTrunk.sipTrunkId;
    } else {
      console.log('2. Creating a new SIP Inbound Trunk...');
      // To connect with Twilio, we generally do NOT want authentication (Twilio sends calls to us)
      const trunk = await sipClient.createSipInboundTrunk(
        'Twilio Inbound Trunk',
        pstnNumbers,
        {
          allowedAddresses: ['0.0.0.0/0'], // allow any incoming domain/address
          includeHeaders: SIPHeaderOptions.SIP_X_HEADERS,
          metadata: JSON.stringify({ tenantId: defaultTenantId, channel: 'pstn_twilio' }),
        }
      );
      
      console.log(`Created SIP Trunk: ${trunk.sipTrunkId}`);
      trunkId = trunk.sipTrunkId;
    }

    console.log('\n3. Checking existing SIP Dispatch Rules...');
    const existingRules = await sipClient.listSipDispatchRule();
    
    const existingPstnRule = existingRules.find(r => r.name === 'Route Twilio PSTN Calls');
    if (existingPstnRule) {
      console.log(`Found existing SIP Dispatch Rule: ${existingPstnRule.sipDispatchRuleId}`);
    } else {
      console.log('4. Creating a new SIP Dispatch Rule...');
      // Route incoming calls to a dynamically generated room named "sip-call-<random>"
      const config = roomConfigFor('pstn_twilio');
      const rule = await sipClient.createSipDispatchRule(
        {
          type: 'individual',
          roomPrefix: 'sip-call-',
        },
        {
          name: 'Route Twilio PSTN Calls',
          metadata: config.metadata,
          trunkIds: [trunkId],
          attributes: {
            channel: 'pstn_twilio',
            tenantId: defaultTenantId,
          },
          roomConfig: config.roomConfig,
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
        whatsAppNumber,
        {
          allowedAddresses: ['0.0.0.0/0'],
          includeHeaders: SIPHeaderOptions.SIP_X_HEADERS,
          metadata: JSON.stringify({ tenantId: defaultTenantId, channel: 'whatsapp' }),
        }
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
          ...roomConfigFor('whatsapp'),
          name: 'Route WhatsApp Voice Calls',
          trunkIds: [waTrunkId],
          attributes: {
            channel: 'whatsapp',
            tenantId: defaultTenantId,
          },
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
    console.log('3. Set LIVEKIT_SIP_URI to the LiveKit SIP URI used by Twilio WhatsApp Voice TwiML.');
    console.log('4. Configure your WhatsApp sender Voice TwiML app to POST to /api/v1/webhooks/twilio/whatsapp-voice.');
    console.log('5. Point your Twilio Phone numbers to route inbound calls to their respective SIP domains.');
    
  } catch (error) {
    console.error('Error setting up SIP:', error);
  }
}

setupSip();
