const { google } = require('googleapis');
require('dotenv').config({ path: '../../.env' });
let email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
let key = process.env.GOOGLE_PRIVATE_KEY || '';
console.log("Original key length:", key.length);
if (!key.includes('BEGIN PRIVATE KEY')) {
  try { key = Buffer.from(key, 'base64').toString('utf8'); } catch {}
}
key = key.replace(/^["']|["']$/g, '');
key = key.replace(/\\n/g, '\n');
if (key.includes('BEGIN PRIVATE KEY')) {
  const bodyMatch = key.replace(/-----BEGIN PRIVATE KEY-----/g, '').replace(/-----END PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const lines = bodyMatch.match(/.{1,64}/g) || [];
  key = `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}
console.log("Processed key length:", key.length);
try {
  const auth = new google.auth.JWT({ email, key, scopes: ['https://www.googleapis.com/auth/calendar'] });
  // Need to force it to parse the key by fetching a token
  auth.getAccessToken().then(() => console.log('SUCCESS! Private key decoded and authenticated with Google successfully.')).catch(e => console.error('Token fetch error:', e.message));
} catch(e) {
  console.error("Sync error:", e.message);
}
