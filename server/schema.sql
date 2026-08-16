CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  login_count INTEGER NOT NULL DEFAULT 0,
  last_login_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS login_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS carrier TEXT,
  ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- Google-authenticated accounts never set a password.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

CREATE TABLE IF NOT EXISTS households (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  app_state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_household_id UUID;

CREATE TABLE IF NOT EXISTS household_memberships (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner',
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, household_id)
);

ALTER TABLE household_memberships
  ADD COLUMN IF NOT EXISTS scopes JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 'edit' (default) or 'view' - a view-only member can see the whole
-- household's data but every mutating request is rejected server-side (see
-- requireEditAccess in server/index.js), not just hidden/disabled in the UI.
ALTER TABLE household_memberships
  ADD COLUMN IF NOT EXISTS access_level TEXT NOT NULL DEFAULT 'edit';

UPDATE users u
SET default_household_id = (
  SELECT hm.household_id
  FROM household_memberships hm
  WHERE hm.user_id = u.id
  ORDER BY hm.created_at ASC
  LIMIT 1
)
WHERE u.default_household_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_household_memberships_user_id
  ON household_memberships(user_id);

CREATE TABLE IF NOT EXISTS household_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  invited_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  invite_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (household_id, email)
);

CREATE INDEX IF NOT EXISTS idx_household_invitations_email
  ON household_invitations(email);

CREATE TABLE IF NOT EXISTS user_shared_modules (
  owner_user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  app_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS login_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_events_created_at
  ON login_events(created_at);

CREATE INDEX IF NOT EXISTS idx_login_events_user_id
  ON login_events(user_id);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id
  ON password_reset_tokens(user_id);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at
  ON password_reset_tokens(expires_at);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user_id
  ON email_verification_tokens(user_id);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_expires_at
  ON email_verification_tokens(expires_at);

CREATE TABLE IF NOT EXISTS notification_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (household_id, source_type, source_id, recipient_email, due_at)
);

CREATE INDEX IF NOT EXISTS idx_notification_jobs_due
  ON notification_jobs(due_at) WHERE sent_at IS NULL;

ALTER TABLE notification_jobs
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS time_zone TEXT;

CREATE TABLE IF NOT EXISTS push_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL DEFAULT 'unknown',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_private_data (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  journal JSONB NOT NULL DEFAULT '{"entries":[]}'::jsonb,
  plans JSONB NOT NULL DEFAULT '{"tasks":[]}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES document_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_folders_household_id ON document_folders(household_id);
CREATE INDEX IF NOT EXISTS idx_document_folders_parent_id ON document_folders(parent_id);

CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  uploaded_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES document_folders(id) ON DELETE SET NULL,
  note_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL,
  size_bytes BIGINT,
  storage_object TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_household_id ON documents(household_id);
CREATE INDEX IF NOT EXISTS idx_documents_folder_id ON documents(folder_id);
CREATE INDEX IF NOT EXISTS idx_documents_note_id ON documents(note_id);

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS wealth_item_type TEXT,
  ADD COLUMN IF NOT EXISTS wealth_item_id TEXT;

CREATE INDEX IF NOT EXISTS idx_documents_wealth_item_id ON documents(wealth_item_id);

ALTER TABLE document_folders
  ADD COLUMN IF NOT EXISTS wealth_item_type TEXT,
  ADD COLUMN IF NOT EXISTS wealth_item_id TEXT;

CREATE INDEX IF NOT EXISTS idx_document_folders_wealth_item_id ON document_folders(wealth_item_id);

-- Documents are family-wide like Decisions/Notes/Meals/Calendar, not tied to
-- one specific household/property book -- scoped by the household's primary
-- owner instead, so they read the same regardless of which of the owner's
-- households is currently selected. household_id is kept as informational
-- provenance (which household a file was added under, used to build its GCS
-- object path) but must no longer cascade-delete the row when that one
-- household is removed, since the owner's other households should keep it.
ALTER TABLE document_folders
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE;

UPDATE document_folders df
SET owner_user_id = (
  SELECT hm.user_id FROM household_memberships hm
  WHERE hm.household_id = df.household_id
  ORDER BY (hm.role = 'owner') DESC, hm.created_at ASC
  LIMIT 1
)
WHERE df.owner_user_id IS NULL;

UPDATE documents d
SET owner_user_id = (
  SELECT hm.user_id FROM household_memberships hm
  WHERE hm.household_id = d.household_id
  ORDER BY (hm.role = 'owner') DESC, hm.created_at ASC
  LIMIT 1
)
WHERE d.owner_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_document_folders_owner_user_id ON document_folders(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_documents_owner_user_id ON documents(owner_user_id);

ALTER TABLE document_folders DROP CONSTRAINT IF EXISTS document_folders_household_id_fkey;
ALTER TABLE document_folders ALTER COLUMN household_id DROP NOT NULL;
ALTER TABLE document_folders ADD CONSTRAINT document_folders_household_id_fkey
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE SET NULL;

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_household_id_fkey;
ALTER TABLE documents ALTER COLUMN household_id DROP NOT NULL;
ALTER TABLE documents ADD CONSTRAINT documents_household_id_fkey
  FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE SET NULL;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS last_opened_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMPTZ;

-- Plain "YYYY-MM-DD" text, not a real DATE column: every other user-entered
-- date in this app (transaction dates, account close dates, debt payment
-- dates) lives inside the JSONB app_state blob as a plain string, and
-- keeping this one the same type avoids node-pg's DATE column parsing (it
-- returns a JS Date object, which round-trips through JSON as a full
-- UTC-midnight timestamp instead of the plain date the client sent).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS expiry_date TEXT;

-- A note's actual content lives in the household's app_state JSONB blob
-- (state.notes.entries), same as everywhere else - this table is only the
-- token -> (household, note) pointer that makes a link resolvable with no
-- session. UNIQUE(household_id, note_id) keeps "get or create a link for
-- this note" idempotent (INSERT ... ON CONFLICT DO UPDATE returns the
-- existing token instead of minting a second live link for the same note).
CREATE TABLE IF NOT EXISTS note_shares (
  token TEXT PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (household_id, note_id)
);

-- Same live token->note pointer idea as note_shares above, but the
-- credential is "being signed in as this specific user" instead of
-- knowledge of a random token - used for sharing a note with a named
-- FamilyLoop account holder (who then sees it under their own login,
-- across households) rather than anyone with a link. id is a real PK
-- (not a natural key) so a share can be addressed/removed by id without
-- the client needing to know the recipient's user id.
CREATE TABLE IF NOT EXISTS note_user_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL,
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  shared_with_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (household_id, note_id, shared_with_user_id)
);
