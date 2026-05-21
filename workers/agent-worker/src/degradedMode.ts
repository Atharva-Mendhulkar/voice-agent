import { getMeter } from '@voice-agent/observability';

const meter = getMeter('agent-worker-degraded');
const providerErrorsCounter = meter.createCounter('provider_errors_total', {
  description: 'Total number of provider service failures triggering degraded mode',
});

export class DegradedModeHandler {
  private readonly cannedResponses = {
    stt_failure: "I'm having trouble hearing you. Could you please repeat that?",
    llm_failure: "I'm experiencing a brief technical issue. Please hold for just a moment.",
    tts_failure: "I apologize, I'm having some audio difficulties. Please stay on the line.",
    tool_failure: "I'm having trouble with the calendar right now. I'll make sure to confirm your appointment by email.",
  };

  async activateDegradedMode(
    session: {
      say: (text: string) => Promise<void>;
      publishDataChannel?: (payload: Buffer) => Promise<void>;
    },
    failureType: keyof typeof this.cannedResponses
  ) {
    const response = this.cannedResponses[failureType];
    console.warn(`[DEGRADED_MODE] Activating degraded mode for: ${failureType}`);

    try {
      // 1. Attempt voice synthesis fallback
      await session.say(response);
    } catch (err) {
      console.error('[DEGRADED_MODE] TTS fallback failed, trying data channel text broadcast...');
      // 2. Fallback to LiveKit data channel message
      if (session.publishDataChannel) {
        try {
          await session.publishDataChannel(
            Buffer.from(
              JSON.stringify({
                type: 'transcript',
                role: 'agent',
                text: `[Degraded Voice Channel]: ${response}`,
              })
            )
          );
        } catch (dataErr) {
          console.error('[DEGRADED_MODE] Data channel transmission failed:', dataErr);
        }
      }
    }

    // Increment telemetry error counters
    providerErrorsCounter.add(1, { provider: failureType, error_type: 'degraded_mode' });
  }
}
