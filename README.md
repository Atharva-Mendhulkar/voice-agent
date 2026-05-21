# Voice Agent LiveKit Architecture

A high-performance, real-time voice reservation and agent platform. This monorepo includes shared packages, client applications, backend gateways, and temporal orchestrators.

## Project Structure

- `apps/`
  - `api-gateway/`: Fastify API serving LiveKit token minting, session controls, and booking cancellations.
  - `frontend/`: Next.js client interface with real-time audio visualization, live transcripts, and reservation controls.
- `packages/`
  - `shared-types/`: Shared event structures and types.
  - `redis-client/`: Redis locking, pub/sub, config cache, and active session counting.
  - `db-client/`: PostgreSQL partitioning, migrations, and Row-Level Security rules.
  - `pii-redactor/`: High-performance PII redaction layer.
  - `session-state/`: Voice agent session state machine.
  - `stt-client/`: Deepgram streaming API wrapper with automatic reconnect policies.
  - `tts-client/`: Cartesia streaming API wrapper with automatic reconnect policies.
  - `eou-detector/`: Semantic end-of-utterance check.
  - `llm-client/`: OpenAI streaming LLM wrapper with support for tool calls.
  - `observability/`: OpenTelemetry metrics and tracing integration, alongside Langfuse LLM logging.
- `workers/`
  - `agent-worker/`: Audio processing worker coordinating STT, LLM, TTS, and state transitions.
  - `temporal-worker/`: Temporal orchestrator executing BookingWorkflow, PG activities, and Saga rollbacks.
- `k8s/`: Kubernetes deployment manifests, including preStop hooks and KEDA scaling configurations.
- `load-tests/`: k6 load tests and chaos simulation scripts.

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
