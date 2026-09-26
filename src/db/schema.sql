CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  actor_user_id UUID,
  actor_email TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ON DELETE CASCADE herdado de uma versao anterior apagaria o historico junto com
-- o tenant. A FK e recriada como RESTRICT para upholdar o append-only.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_tenant_id_fkey;
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS channel_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  network TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  encrypted_secret TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  token_expires_at TIMESTAMPTZ,
  -- Limites autoritativos do provedor (Fase 7). O Postiz responde o
  -- integration-settings de cada integracao, e o maxLength dali e a fonte da
  -- verdade: NETWORK_SPECS tem numero inferido eNetwork pode mudar sem alterar
  -- o codigo. rules fica guardado para transparence; e texto do provedor, nao
  -- schema, entao nao entra na validacao. NULL = nunca sincronizado, e a
  -- validacao cai no NETWORK_SPECS.
  provider_max_length INTEGER,
  provider_rules TEXT,
  specs_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, network, external_account_id)
);

ALTER TABLE channel_accounts ADD COLUMN IF NOT EXISTS provider_max_length INTEGER;
ALTER TABLE channel_accounts ADD COLUMN IF NOT EXISTS provider_rules TEXT;
ALTER TABLE channel_accounts ADD COLUMN IF NOT EXISTS specs_synced_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  media JSONB NOT NULL DEFAULT '[]'::jsonb,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS publish_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  post_id UUID NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  channel_account_id UUID NOT NULL REFERENCES channel_accounts (id) ON DELETE CASCADE,
  network TEXT NOT NULL,
  recipient TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  scheduled_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  external_post_id TEXT,
  permalink TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  language_code TEXT NOT NULL DEFAULT 'pt_BR',
  category TEXT NOT NULL DEFAULT 'MARKETING',
  status TEXT NOT NULL DEFAULT 'PENDING',
  header_type TEXT NOT NULL DEFAULT 'NONE',
  variable_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name, language_code)
);

-- Fila morta (Fase 9). Guarda o job que ESGOTOU as tentativas sendo ainda
-- retentavel, que e o unico caso em que reexecutar faz sentido: falha nao
-- retentavel (conteudo invalido, conta removida) nao entra aqui, porque nunca
-- vai passar e a entrada so poluiria a fila com trabalho doomed.
--
-- Fica no Postgres e nao no Redis por dois motivos: o estado autoritativo do
-- job ja e a tabela publish_jobs, e o operador precisa filtrar por tenant, o
-- que o RLS da e de graca e o Redis nao da.
CREATE TABLE IF NOT EXISTS dead_letter_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- Um job so pode estar na fila morta uma vez por ciclo; um novo dead-letter
  -- do mesmo job (requeue, falha, novo dead-letter) atualiza a linha.
  job_id UUID NOT NULL REFERENCES publish_jobs (id) ON DELETE CASCADE,
  post_id UUID NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  channel_account_id UUID NOT NULL REFERENCES channel_accounts (id) ON DELETE CASCADE,
  network TEXT NOT NULL,
  recipient TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_error_code TEXT,
  -- NULL = aberto, ninguem tratou ainda. 'requeued' = voltou para a fila.
  -- 'discarded' = operador decidiu desistir. resolved_at preenchido = fechada.
  resolution TEXT,
  resolved_at TIMESTAMPTZ,
  -- Quantas vezes esse job ja voltou da fila morta. Serve para o operador ver
  -- que requeue em laco existe, em vez de so espiar o mesmo erro.
  requeue_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_accounts_tenant ON channel_accounts (tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_created ON audit_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns (tenant_id);
CREATE INDEX IF NOT EXISTS idx_posts_campaign ON posts (tenant_id, campaign_id);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_due ON publish_jobs (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_tenant ON publish_jobs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_dead_letter_jobs_open ON dead_letter_jobs (tenant_id, resolution, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_lookup ON whatsapp_templates (tenant_id, name, language_code);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE publish_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE dead_letter_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_templates ENABLE ROW LEVEL SECURITY;

ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE channel_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
ALTER TABLE posts FORCE ROW LEVEL SECURITY;
ALTER TABLE publish_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE dead_letter_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_templates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_users ON users;
DROP POLICY IF EXISTS tenant_isolation_audit_log ON audit_log;
DROP POLICY IF EXISTS tenant_isolation_channel_accounts ON channel_accounts;
DROP POLICY IF EXISTS tenant_isolation_campaigns ON campaigns;
DROP POLICY IF EXISTS tenant_isolation_posts ON posts;
DROP POLICY IF EXISTS tenant_isolation_publish_jobs ON publish_jobs;
DROP POLICY IF EXISTS tenant_isolation_dead_letter_jobs ON dead_letter_jobs;
DROP POLICY IF EXISTS tenant_isolation_whatsapp_templates ON whatsapp_templates;

CREATE POLICY tenant_isolation_users ON users
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- audit_log e append-only de verdade: existem policies so para SELECT e INSERT.
-- Nao existe policy para UPDATE/DELETE, e o Postgres nega o que nao tem policy.
-- Comentar o log exigiria antes revogar estas policies explicitamente.
DROP POLICY IF EXISTS tenant_isolation_audit_log ON audit_log;
DROP POLICY IF EXISTS tenant_isolation_audit_log_read ON audit_log;
DROP POLICY IF EXISTS tenant_isolation_audit_log_write ON audit_log;

CREATE POLICY tenant_isolation_audit_log_read ON audit_log
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_audit_log_write ON audit_log
  FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_channel_accounts ON channel_accounts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_campaigns ON campaigns
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_posts ON posts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_publish_jobs ON publish_jobs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_dead_letter_jobs ON dead_letter_jobs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_whatsapp_templates ON whatsapp_templates
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- O papel da aplicacao precisa ser NO superuser e NO bypassrls, senao as policies acima
-- sao inertes: superuser ignora RLS mesmo com FORCE ROW LEVEL SECURITY.
GRANT CONNECT ON DATABASE postmidia TO postmidia_app;
GRANT USAGE ON SCHEMA public TO postmidia_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO postmidia_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO postmidia_app;

-- O grant acima e generico demais para o log de auditoria: da a app UPDATE e DELETE
-- nela. A policy ja bloqueia, mas nao e defense in depth deixar o privilegio concedido.
REVOKE UPDATE, DELETE ON audit_log FROM postmidia_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO postmidia_app;

-- Vale para tabelas criadas depois deste ALTER tambem; o REVOKE acima e explicito
-- por tabela e precisa ser reaplicado se o schema ganhar outra tabela de log.
