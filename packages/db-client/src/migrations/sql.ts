export const MIGRATION_001_INIT = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- Tenants
CREATE TABLE IF NOT EXISTS tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255) NOT NULL,
  slug          VARCHAR(100) UNIQUE NOT NULL,
  config        JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sessions (Partitioned by created_at)
CREATE TABLE IF NOT EXISTS sessions (
  id            UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  room_id       VARCHAR(255) NOT NULL,
  channel       VARCHAR(50) NOT NULL CHECK (channel IN ('web', 'pstn_twilio', 'pstn_exotel', 'whatsapp')),
  caller_id     VARCHAR(255),           -- phone number (PII, encrypted at rest)
  state         VARCHAR(50) NOT NULL DEFAULT 'CONNECTING',
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at      TIMESTAMPTZ,
  duration_sec  INTEGER,
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Bookings (Partitioned by created_at)
CREATE TABLE IF NOT EXISTS bookings (
  id                  UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  session_id          UUID,
  confirmation_code   VARCHAR(20) NOT NULL,
  calendar_event_id   VARCHAR(255) NOT NULL,
  calendar_id         VARCHAR(255) NOT NULL,
  attendee_email      VARCHAR(255) NOT NULL,  -- PII, encrypted
  attendee_name       VARCHAR(255) NOT NULL,  -- PII, encrypted
  start_time          TIMESTAMPTZ NOT NULL,
  end_time            TIMESTAMPTZ NOT NULL,
  duration_minutes    INTEGER NOT NULL DEFAULT 30,
  timezone            VARCHAR(100) NOT NULL,
  status              VARCHAR(50) NOT NULL DEFAULT 'confirmed'
                        CHECK (status IN ('confirmed', 'cancelled', 'rescheduled', 'no_show')),
  temporal_workflow_id VARCHAR(255),
  idempotency_key     VARCHAR(255),
  meet_link           VARCHAR(500),
  notes               TEXT,
  cancelled_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Transcripts (Partitioned by created_at)
CREATE TABLE IF NOT EXISTS transcripts (
  id          UUID NOT NULL DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL,
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  role        VARCHAR(10) NOT NULL CHECK (role IN ('user', 'agent')),
  text        TEXT NOT NULL,       -- PII redacted before insert
  turn_index  INTEGER NOT NULL,
  timestamp   TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Events (audit trail) (Partitioned by occurred_at)
CREATE TABLE IF NOT EXISTS session_events (
  id          UUID NOT NULL DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL,
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  event_type  VARCHAR(100) NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Memory Embeddings (Not Partitioned, lookup heavy by tenant)
CREATE TABLE IF NOT EXISTS memory_embeddings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  session_id  UUID,
  source      VARCHAR(50) NOT NULL CHECK (source IN ('transcript', 'booking', 'preference', 'faq')),
  content     TEXT NOT NULL,
  embedding   VECTOR(1536) NOT NULL,     -- OpenAI text-embedding-3-small
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partition Tables for 2026 (ignore errors if they exist)
CREATE TABLE IF NOT EXISTS sessions_2026_q1 PARTITION OF sessions FOR VALUES FROM ('2026-01-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS sessions_2026_q2 PARTITION OF sessions FOR VALUES FROM ('2026-04-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS sessions_2026_q3 PARTITION OF sessions FOR VALUES FROM ('2026-07-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS sessions_2026_q4 PARTITION OF sessions FOR VALUES FROM ('2026-10-01') TO ('2027-01-01');

CREATE TABLE IF NOT EXISTS bookings_2026_q1 PARTITION OF bookings FOR VALUES FROM ('2026-01-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS bookings_2026_q2 PARTITION OF bookings FOR VALUES FROM ('2026-04-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS bookings_2026_q3 PARTITION OF bookings FOR VALUES FROM ('2026-07-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS bookings_2026_q4 PARTITION OF bookings FOR VALUES FROM ('2026-10-01') TO ('2027-01-01');

CREATE TABLE IF NOT EXISTS transcripts_2026_q1 PARTITION OF transcripts FOR VALUES FROM ('2026-01-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS transcripts_2026_q2 PARTITION OF transcripts FOR VALUES FROM ('2026-04-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS transcripts_2026_q3 PARTITION OF transcripts FOR VALUES FROM ('2026-07-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS transcripts_2026_q4 PARTITION OF transcripts FOR VALUES FROM ('2026-10-01') TO ('2027-01-01');

CREATE TABLE IF NOT EXISTS session_events_2026_q1 PARTITION OF session_events FOR VALUES FROM ('2026-01-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS session_events_2026_q2 PARTITION OF session_events FOR VALUES FROM ('2026-04-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS session_events_2026_q3 PARTITION OF session_events FOR VALUES FROM ('2026-07-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS session_events_2026_q4 PARTITION OF session_events FOR VALUES FROM ('2026-10-01') TO ('2027-01-01');

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_created ON sessions(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_room ON sessions(room_id);

CREATE INDEX IF NOT EXISTS idx_bookings_tenant_status ON bookings(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_confirmation ON bookings(confirmation_code);
CREATE INDEX IF NOT EXISTS idx_bookings_start_time ON bookings(start_time) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_transcripts_tenant ON transcripts(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_embeddings_tenant ON memory_embeddings(tenant_id);
`;

export const MIGRATION_002_RLS = `
-- Create non-superuser role for RLS enforcement
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'voice_app_user') THEN
    CREATE ROLE voice_app_user WITH LOGIN PASSWORD 'voice_app_password';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO voice_app_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO voice_app_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO voice_app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO voice_app_user;

-- Enable RLS
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings FORCE ROW LEVEL SECURITY;
ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcripts FORCE ROW LEVEL SECURITY;
ALTER TABLE session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_events FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_embeddings FORCE ROW LEVEL SECURITY;

-- Create Isolation Policies checking 'app.current_tenant_id' context variable
DROP POLICY IF EXISTS tenant_isolation_tenants ON tenants;
CREATE POLICY tenant_isolation_tenants ON tenants
  FOR ALL
  USING (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_sessions ON sessions;
CREATE POLICY tenant_isolation_sessions ON sessions
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_bookings ON bookings;
CREATE POLICY tenant_isolation_bookings ON bookings
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_transcripts ON transcripts;
CREATE POLICY tenant_isolation_transcripts ON transcripts
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_session_events ON session_events;
CREATE POLICY tenant_isolation_session_events ON session_events
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_embeddings ON memory_embeddings;
CREATE POLICY tenant_isolation_embeddings ON memory_embeddings
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
`;
