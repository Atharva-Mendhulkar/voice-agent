import twilio from 'twilio';
import dotenv from 'dotenv';
dotenv.config();

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_WHATSAPP_FROM || '+14155238886';
// Ensure prefix
const from = fromNumber.startsWith('whatsapp:') ? fromNumber : `whatsapp:${fromNumber}`;

const client = twilio(accountSid, authToken);

async function test() {
  const toNumber = process.argv[2];
  if (!toNumber) {
    console.error("Usage: npx tsx scripts/test-whatsapp.ts <phone_number>");
    process.exit(1);
  }
  
  const to = toNumber.startsWith('whatsapp:') ? toNumber : `whatsapp:${toNumber.startsWith('+') ? toNumber : '+' + toNumber}`;

  console.log(`Sending test WhatsApp message from ${from} to ${to}...`);
  try {
    const message = await client.messages.create({
      body: 'Hello! This is a test confirmation from the Voice Agent.',
      from,
      to
    });
    console.log(`Success! Message SID: ${message.sid}`);
  } catch (err) {
    console.error('Failed to send WhatsApp message:', err);
  }
}

test();
