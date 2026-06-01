import { Connection, Client } from '@temporalio/client';

async function run() {
  const connection = await Connection.connect({ address: 'localhost:7233' });
  const client = new Client({ connection });

  console.log('Starting dummy BookingWorkflow with WhatsApp...');
  try {
    const handle = await client.workflow.start('BookingWorkflow', {
      taskQueue: 'booking-queue',
      workflowId: `test-whatsapp-${Date.now()}`,
      args: [
        {
          roomId: 'test-room',
          tenantId: '00000000-0000-0000-0000-000000000000', // Need an actual tenantId if DB checks it
          requestId: `req-${Date.now()}`,
          appointment: {
            date: '2026-06-15',
            time: '14:00',
            durationMinutes: 30,
            attendeeEmail: 'test@example.com',
            attendeePhone: '+14155552671', // Test phone
            attendeeName: 'Test User',
            calendarId: 'primary',
            timezone: 'UTC'
          }
        }
      ]
    });
    console.log(`Started workflow: ${handle.workflowId}`);
    const result = await handle.result();
    console.log('Workflow result:', result);
  } catch (err) {
    console.error('Workflow failed:', err);
  }
}

run();
