# Voice Agent LiveKit Architecture

A high-performance, real-time voice reservation and agent platform. This monorepo includes shared packages, client applications, backend gateways, and temporal orchestrators.

## Project Structure and Components

This monorepo is organized into three main areas: **Apps** (user-facing and API gateways), **Workers** (background processing and AI execution), and **Packages** (shared business logic and infrastructure clients).

### Apps (`apps/`)
These are the entry points to the system that accept inbound connections from users.
- **`apps/api-gateway/`**: A Fastify REST API. It handles HTTP requests from the frontend, mints secure access tokens for LiveKit sessions, fetches session history, and dispatches cancellation requests to Temporal.
- **`apps/frontend/`**: A Next.js web application. This provides the user interface for end-users to interact with the voice agent. It uses the `@livekit/components-react` library for real-time audio visualization, live transcripts, and WebRTC streaming.

### Workers (`workers/`)
Workers operate in the background and execute the core logic of the system.
- **`workers/agent-worker/`**: The brain of the voice AI. Built on the `@livekit/agents` framework, this Node.js worker connects to LiveKit rooms, processes incoming audio using a Voice Activity Detector (Silero VAD), converts speech to text (Deepgram STT), routes it to an LLM (OpenAI) for decision making/tool execution, and synthesizes the response back to audio (OpenAI/Cartesia TTS).
- **`workers/temporal-worker/`**: The orchestration layer. It runs Temporal workflows and activities to safely execute distributed transactions like checking Google Calendar availability, locking slots via Redis, writing booking records to PostgreSQL, and sending confirmation emails.

### Packages (`packages/`)
Internal shared libraries used by the Apps and Workers.
- **`packages/shared-types/`**: TypeScript interfaces and Zod schemas shared across the stack.
- **`packages/redis-client/`**: Redis utilities for distributed locking, pub/sub communication, config caching, and tracking active voice sessions.
- **`packages/db-client/`**: PostgreSQL client with utilities for Row-Level Security (RLS) and database migrations.
- **`packages/pii-redactor/`**: A utility layer for stripping sensitive Personally Identifiable Information from logs and transcripts before they are persisted.
- **`packages/session-state/`**: State machine logic for managing the lifecycle of a voice agent session.
- **`packages/stt-client/`, `tts-client/`, `llm-client/`**: Legacy streaming API wrappers (largely superseded by the official LiveKit Agents plugins, but maintained for backwards compatibility and custom observability integrations).
- **`packages/eou-detector/`**: Semantic end-of-utterance checking utilities.
- **`packages/observability/`**: OpenTelemetry metrics, tracing integration, and custom logging.

### Infrastructure (`k8s/`, `load-tests/`)
- **`k8s/`**: Kubernetes deployment manifests, including KEDA configurations for autoscaling based on queue length, and preStop hooks for graceful shutdown.
- **`load-tests/`**: k6 scripts designed to simulate high traffic against the API gateway and verify system resilience.

## Architecture Workflow

```mermaid
sequenceDiagram
    participant T as Twilio/PSTN
    participant U as Web User
    participant F as Frontend (Next.js)
    participant API as API Gateway (Fastify)
    participant LK as LiveKit Cloud
    participant AW as Agent Worker (Node.js)
    participant TW as Temporal Worker

    U->>F: Opens App & Clicks "Connect"
    F->>API: POST /api/sessions (Request Token)
    API-->>F: Returns JWT Token
    F->>LK: Connects via WebRTC
    
    T->>LK: SIP INVITE (Phone Call)
    
    LK->>AW: Dispatches job to Agent Worker
    
    note over U,AW: Real-time Audio Streaming begins
    
    U->>LK: Speaks (Audio Stream)
    LK->>AW: Forwards Audio
    AW->>AW: VAD (Silero) detects End of Speech
    AW->>AW: STT (Deepgram) transcribes Audio
    AW->>AW: LLM (OpenAI) processes transcript
    
    alt Needs Booking?
        AW->>TW: Triggers BookingWorkflow
        TW->>TW: Holds slot in Redis
        TW->>TW: Saves to PostgreSQL
        TW->>TW: Syncs to Google Calendar
        TW-->>AW: Returns Success/Failure
    end

    AW->>AW: TTS (OpenAI) synthesizes response
    AW->>LK: Sends Audio Stream back
    LK->>U: Plays Web Audio
    LK->>T: Plays Phone Audio
```

## Project Status Checklist

### Completed
- [x] **Monorepo Setup:** TurboRepo configured with isolated packages (DB, Redis, Types, Observability).
- [x] **LiveKit Voice Agent:** Node.js agent using `@livekit/agents` framework.
- [x] **Conversational Pipeline:** Deepgram STT -> OpenAI LLM -> OpenAI TTS.
- [x] **Temporal Orchestration:** Saga-based `BookingWorkflow` execution for safety.
- [x] **Google Calendar Sync:** Full bi-directional checking and booking via Service Accounts.
- [x] **Latency Tuning:** Silero VAD min_silence_duration reduced to 300ms.
- [x] **Telephony Integration:** Twilio SIP Inbound Trunk & Dispatch Rules created in LiveKit.
- [x] **WhatsApp Voice Calling:** Twilio TwiML proxy to LiveKit SIP trunk integrated and verified.

### Pending / Next Steps
- [ ] **Observability (Langfuse):** Inject Langfuse tracing into the LLM completion streams for analytics.
- [ ] **Post-Call Data Pipeline:** Trigger `PostCallWorkflow` to save full transcripts to PostgreSQL on session end.
- [ ] **Cartesia TTS Re-enable:** Switch back from OpenAI TTS to Cartesia Sonic once billing is resolved.

## Installation

Ensure pnpm is installed globally. Install all dependencies from the root directory:

```bash
pnpm install
```

## Setup Configuration

Create a `.env` file at the root using the provided `.env.example`:

```bash
cp .env.example .env
```

Configure the following environment variables:
- `DATABASE_URL`: PostgreSQL connection string.
- `REDIS_URL`: Redis connection string.
- `TEMPORAL_ADDRESS`: Address of the Temporal cluster.
- `OPENAI_API_KEY`: API key for OpenAI services.
- `DEEPGRAM_API_KEY`: API key for Deepgram speech-to-text.
- `CARTESIA_API_KEY`: API key for Cartesia text-to-speech.
- `LIVEKIT_API_KEY` & `LIVEKIT_API_SECRET`: Credentials for the LiveKit server.

### Google Calendar Setup
To enable Google Calendar syncing, you must configure a Google Service Account:
1. Create a Service Account in Google Cloud Console.
2. Share the target calendar with the Service Account email.
3. Export the JSON key.
4. Set `GOOGLE_SERVICE_ACCOUNT_EMAIL` to the service account email.
5. Set `GOOGLE_PRIVATE_KEY` to the private key. If using a `.env` file, you can wrap the multiline key in double quotes (the system will automatically parse out the quotes and newlines).

### Twilio SIP Setup
The voice agent supports inbound phone calls via Twilio SIP trunking.
1. Run `npx ts-node scripts/setup-sip.ts` to provision a SIP Inbound Trunk in LiveKit.
2. The script will output a LiveKit SIP URI.
3. In Twilio Console, go to Voice > Manage > SIP Domains.
4. Create a new SIP Domain (e.g., `voice-agent.sip.twilio.com`).
5. Set the Twilio Origination URI to the LiveKit SIP URI.
6. Route your Twilio Phone Number to the new SIP domain.
7. To handle Twilio webhooks (optional), set `TWILIO_AUTH_TOKEN` in your environment variables. The API gateway listens at `/api/v1/webhooks/twilio` for status callbacks.

### WhatsApp Voice Calling Setup
WhatsApp Business Calling can be integrated by pointing your WhatsApp sender's Voice Webhook URL to the API Gateway. It utilizes the same LiveKit SIP trunking infrastructure.
1. Ensure your Twilio WhatsApp sender is activated for voice capabilities.
2. In the Twilio Console, navigate to your WhatsApp sender configuration.
3. Set the **Voice Webhook URL** to your server: `https://<your-domain>/api/v1/webhooks/twilio/whatsapp-voice`
4. When a user calls your WhatsApp number, Twilio invokes this webhook which returns TwiML containing a `<Sip>` verb, seamlessly bridging the WhatsApp audio to your LiveKit agent.

## Building the Workspace

Compile all typescript packages and applications:

```bash
pnpm -r build
```

## Running the Applications Locally

1. Start database, cache, and orchestrator dependencies:
   Ensure PostgreSQL, Redis, and Temporal are active.

2. Start the Temporal Worker:
   ```bash
   pnpm --filter @voice-agent/temporal-worker start
   ```

3. Start the API Gateway:
   ```bash
   pnpm --filter @voice-agent/api-gateway start
   ```

4. Start the Next.js Client Frontend:
   ```bash
   pnpm --filter @voice-agent/frontend dev
   ```

## Running Validation Tests

### E2E Validation
Verify the entire system end-to-end including database migrations, package audits, API gateway integration, and Temporal workflows:

```bash
pnpm validate
```

### Load Testing
Execute the k6 simulation suite to verify HTTP gateway throughput and cancellation dispatch:

```bash
k6 run load-tests/booking-load-test.js
```

### Chaos Testing
Verify the kubernetes preStop call-draining hook using the chaos test script:

```bash
./load-tests/chaos-test.sh
```
