-- Enable Vector Extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Roles Enum
CREATE TYPE user_role AS ENUM ('owner', 'admin', 'client');

-- Tenants Table (Mother & Child Bot Configurations)
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id BIGINT NOT NULL UNIQUE,
  telegram_username TEXT,
  role user_role NOT NULL DEFAULT 'client',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'ACTIVE')),
  child_bot_token TEXT,
  child_bot_username TEXT,
  website_url TEXT,
  ai_provider TEXT CHECK (ai_provider IN ('openai', 'deepseek', 'gapgpt', 'liara')),
  ai_api_key TEXT,
  hosting_choice TEXT CHECK (hosting_choice IN ('MANAGED', 'SELF_HOSTED_GUIDE', 'CUSTOM_REQUEST')),
  lead_channel_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Knowledge Base Table (Vector Storage)
CREATE TABLE knowledge_base (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  page_url TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Chat Sessions Table
CREATE TABLE chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  user_telegram_id BIGINT NOT NULL,
  user_username TEXT,
  user_first_name TEXT,
  user_last_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'archived')),
  started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMP WITH TIME ZONE,
  message_count INT DEFAULT 0,
  lead_summary JSONB,
  lead_sent_to_channel BOOLEAN DEFAULT FALSE
);

-- Chat Messages Table
CREATE TABLE chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  telegram_message_id BIGINT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Lead Summaries Table (for analytics)
CREATE TABLE lead_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  user_telegram_id BIGINT NOT NULL,
  lead_name TEXT,
  contact_info TEXT,
  intent_level TEXT CHECK (intent_level IN ('High', 'Medium', 'Low', 'Inquiry Only')),
  summary TEXT,
  full_transcript TEXT,
  message_count INT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX ON knowledge_base USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_knowledge_base_tenant_id ON knowledge_base(tenant_id);
CREATE INDEX idx_tenants_telegram_user_id ON tenants(telegram_user_id);
CREATE INDEX idx_tenants_status ON tenants(status);
CREATE INDEX idx_tenants_role ON tenants(role);
CREATE INDEX idx_chat_sessions_tenant_id ON chat_sessions(tenant_id);
CREATE INDEX idx_chat_sessions_user_telegram_id ON chat_sessions(user_telegram_id);
CREATE INDEX idx_chat_sessions_status ON chat_sessions(status);
CREATE INDEX idx_chat_messages_session_id ON chat_messages(session_id);
CREATE INDEX idx_chat_messages_created_at ON chat_messages(created_at);
CREATE INDEX idx_lead_summaries_tenant_id ON lead_summaries(tenant_id);
CREATE INDEX idx_lead_summaries_created_at ON lead_summaries(created_at);

-- Isolated Similarity Search RPC Function
CREATE OR REPLACE FUNCTION match_child_bot_knowledge (
  query_embedding VECTOR(1536),
  target_tenant_id UUID,
  match_threshold FLOAT,
  match_count INT
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  page_url TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kb.id,
    kb.content,
    kb.page_url,
    1 - (kb.embedding <=> query_embedding) AS similarity
  FROM knowledge_base kb
  WHERE kb.tenant_id = target_tenant_id
    AND 1 - (kb.embedding <=> query_embedding) > match_threshold
  ORDER BY kb.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Function to create or get active session
CREATE OR REPLACE FUNCTION get_or_create_active_session(
  p_tenant_id UUID,
  p_user_telegram_id BIGINT,
  p_user_username TEXT,
  p_user_first_name TEXT,
  p_user_last_name TEXT
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_session_id UUID;
BEGIN
  -- Try to find existing active session
  SELECT id INTO v_session_id
  FROM chat_sessions
  WHERE tenant_id = p_tenant_id
    AND user_telegram_id = p_user_telegram_id
    AND status = 'active'
  ORDER BY started_at DESC
  LIMIT 1;
  
  IF v_session_id IS NOT NULL THEN
    RETURN v_session_id;
  END IF;
  
  -- Create new session
  INSERT INTO chat_sessions (tenant_id, user_telegram_id, user_username, user_first_name, user_last_name)
  VALUES (p_tenant_id, p_user_telegram_id, p_user_username, p_user_first_name, p_user_last_name)
  RETURNING id INTO v_session_id;
  
  RETURN v_session_id;
END;
$$;

-- Function to add message to session
CREATE OR REPLACE FUNCTION add_message_to_session(
  p_session_id UUID,
  p_role TEXT,
  p_content TEXT,
  p_telegram_message_id BIGINT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO chat_messages (session_id, role, content, telegram_message_id)
  VALUES (p_session_id, p_role, p_content, p_telegram_message_id);
  
  UPDATE chat_sessions
  SET message_count = message_count + 1
  WHERE id = p_session_id;
END;
$$;

-- Function to close session and save lead summary
CREATE OR REPLACE FUNCTION close_session_and_save_lead(
  p_session_id UUID,
  p_lead_summary JSONB
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant_id UUID;
  v_user_telegram_id BIGINT;
  v_message_count INT;
BEGIN
  -- Update session
  UPDATE chat_sessions
  SET status = 'closed', ended_at = NOW(), lead_summary = p_lead_summary
  WHERE id = p_session_id
  RETURNING tenant_id, user_telegram_id, message_count
  INTO v_tenant_id, v_user_telegram_id, v_message_count;
  
  -- Save lead summary for analytics
  INSERT INTO lead_summaries (
    session_id, tenant_id, user_telegram_id,
    lead_name, contact_info, intent_level, summary,
    full_transcript, message_count
  )
  SELECT
    p_session_id, v_tenant_id, v_user_telegram_id,
    p_lead_summary->>'lead_name',
    p_lead_summary->>'contact',
    p_lead_summary->>'intent',
    p_lead_summary->>'summary',
    (
      SELECT string_agg(role || ': ' || content, E'\n')
      FROM chat_messages
      WHERE session_id = p_session_id
      ORDER BY created_at
    ),
    v_message_count;
END;
$$;

-- Enable Row Level Security
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_summaries ENABLE ROW LEVEL SECURITY;

-- Policies (service role has full access)
CREATE POLICY "Service role can do everything on tenants" ON tenants
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role can do everything on knowledge_base" ON knowledge_base
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role can do everything on chat_sessions" ON chat_sessions
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role can do everything on chat_messages" ON chat_messages
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role can do everything on lead_summaries" ON lead_summaries
  FOR ALL USING (auth.role() = 'service_role');