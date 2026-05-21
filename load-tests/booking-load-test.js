import http from 'k6/http';
import { sleep, check } from 'k6';

export const options = {
  scenarios: {
    booking_flow: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: 10,
      maxVUs: 50,
      stages: [
        { target: 10, duration: '30s' }, // Ramp up to 10 session calls per second
        { target: 10, duration: '1m' },  // Sustain load
        { target: 0, duration: '30s' },  // Cooldown
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'], // 95% of requests must complete below 500ms
    http_req_failed: ['rate<0.01'],    // Error rate must be less than 1%
  },
};

const BASE_URL = 'http://localhost:8000';
const TENANT_ID = 'd3b07384-d113-4ec3-a558-e04e662e3f62';

export default function () {
  // Scenario 1: Start Booking Session
  const sessionPayload = JSON.stringify({
    tenantId: TENANT_ID,
    channel: 'web',
  });

  const sessionParams = {
    headers: {
      'Content-Type': 'application/json',
    },
  };

  const sessionRes = http.post(`${BASE_URL}/api/sessions`, sessionPayload, sessionParams);

  check(sessionRes, {
    'session status is 200': (r) => r.status === 200,
    'has token': (r) => JSON.parse(r.body).token !== undefined,
  });

  if (sessionRes.status === 200) {
    const { roomId } = JSON.parse(sessionRes.body);

    // Simulate average user conversation time (5-10s)
    sleep(Math.random() * 5 + 5);

    // Scenario 2: Simulate Booking Cancellation for this room
    const cancelPayload = JSON.stringify({
      tenantId: TENANT_ID,
      confirmationCode: `CONF-${Math.floor(100000 + Math.random() * 900000)}`,
      roomId: roomId,
    });

    const cancelRes = http.post(`${BASE_URL}/api/bookings/cancel`, cancelPayload, sessionParams);

    check(cancelRes, {
      'cancel status is 200': (r) => r.status === 200,
    });
  }

  sleep(1);
}
