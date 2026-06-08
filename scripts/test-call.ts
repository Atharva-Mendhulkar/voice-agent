import twilio from 'twilio';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

async function makeCall() {
  const fromNumber = process.env.TWILIO_PSTN_NUMBERS;
  const toNumber = '+918591436357';
  
  const webhookUrl = process.env.PUBLIC_BASE_URL + '/api/v1/webhooks/twilio/whatsapp-voice';

  console.log(`Initiating call from ${fromNumber} to ${toNumber}...`);
  console.log(`Using webhook URL: ${webhookUrl}`);
  
  try {
    const call = await client.calls.create({
      url: webhookUrl,
      to: toNumber,
      from: fromNumber
    });
    console.log(`Call successfully initiated! Call SID: ${call.sid}`);
  } catch (error) {
    console.error('Error initiating call:', error);
  }
}

makeCall();
