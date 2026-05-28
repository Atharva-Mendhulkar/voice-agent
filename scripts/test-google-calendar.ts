import dotenv from 'dotenv';
import { google } from 'googleapis';

dotenv.config();

async function run() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY || '';
  if (!email || !key) return console.log('No credentials');
  
  // replace newlines
  key = key.replace(/\\n/g, '\n').replace(/^["']|["']$/g, '');
  
  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  
  const calendar = google.calendar({ version: 'v3', auth });
  try {
    const res = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: 'Test Event',
        start: { dateTime: new Date().toISOString() },
        end: { dateTime: new Date(Date.now() + 3600000).toISOString() },
      }
    });
    console.log('Success primary:', res.data.id);
  } catch (err: any) {
    console.log('Error primary:', err.message);
  }
}
run();
