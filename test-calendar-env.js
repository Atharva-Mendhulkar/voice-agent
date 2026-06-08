require('dotenv').config();
const { google } = require('googleapis');

async function testCalendar() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY || '';
  if (!key.includes('BEGIN PRIVATE KEY')) {
    try { key = Buffer.from(key, 'base64').toString('utf8'); } catch {}
  }
  key = key.replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');

  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });

  const calendar = google.calendar({ version: 'v3', auth });

  const targetCalendarId = process.env.TARGET_CALENDAR_ID;
  console.log("Target Calendar ID from .env:", targetCalendarId);

  console.log("Inserting a test event...");
  const startTime = new Date();
  startTime.setHours(startTime.getHours() + 2); // 2 hours from now
  const endTime = new Date(startTime.getTime() + 30 * 60000);

  try {
    const eventRes = await calendar.events.insert({
      calendarId: targetCalendarId,
      requestBody: {
        summary: 'Voice Agent Final Test',
        description: 'Testing the calendar API integration into user calendar.',
        start: { dateTime: startTime.toISOString() },
        end: { dateTime: endTime.toISOString() },
      },
    });
    console.log("Successfully created event:", eventRes.data.id);
    console.log("Event Link:", eventRes.data.htmlLink);

  } catch (err) {
    console.error("Error testing calendar:", err.message);
  }
}

testCalendar();
