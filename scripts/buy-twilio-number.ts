import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;

async function buyNumber() {
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  
  console.log('1. Searching for an available US number...');
  const searchRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/US/Local.json`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  
  if (!searchRes.ok) {
    console.error('Failed to search numbers:', await searchRes.text());
    return;
  }
  
  const searchData = await searchRes.json() as any;
  if (!searchData.available_phone_numbers || searchData.available_phone_numbers.length === 0) {
    console.error('No available numbers found.');
    return;
  }
  
  const numberToBuy = searchData.available_phone_numbers[0].phone_number;
  console.log(`Found number: ${numberToBuy}. Attempting to purchase...`);
  
  const buyRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ PhoneNumber: numberToBuy })
  });
  
  if (!buyRes.ok) {
    console.error('Failed to buy number:', await buyRes.text());
    return;
  }
  
  const buyData = await buyRes.json();
  console.log('SUCCESS! Purchased number:', buyData.phone_number);
}

buyNumber().catch(console.error);
