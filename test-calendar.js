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

  console.log("Inserting a test event...");
  const startTime = new Date();
  startTime.setHours(startTime.getHours() + 1); // 1 hour from now
  const endTime = new Date(startTime.getTime() + 30 * 60000);

  try {
    const eventRes = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: 'Agent Test Booking',
        description: 'Testing the calendar API integration.',
        start: { dateTime: startTime.toISOString() },
        end: { dateTime: endTime.toISOString() },
      },
    });
    console.log("Successfully created event:", eventRes.data.id);
    console.log("Event Link:", eventRes.data.htmlLink);

    console.log("\nFetching recent events from the calendar...");
    const listRes = await calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      maxResults: 5,
      singleEvents: true,
      orderBy: 'startTime',
    });
    const events = listRes.data.items;
    if (events.length) {
      console.log('Upcoming events:');
      events.map((event, i) => {
        const start = event.start.dateTime || event.start.date;
        console.log(`${start} - ${event.summary} (ID: ${event.id})`);
      });
    } else {
      console.log('No upcoming events found.');
    }
  } catch (err) {
    console.error("Error testing calendar:", err.message);
  }
}

testCalendar();
