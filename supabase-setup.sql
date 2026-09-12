-- Penn Pain Dashboard — Supabase Setup
-- Run this in the Supabase SQL Editor

-- Dashboard Users (email/password login)
CREATE TABLE dashboard_users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  role TEXT DEFAULT 'viewer',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE dashboard_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON dashboard_users FOR ALL USING (true);
GRANT ALL ON dashboard_users TO service_role;

-- Add users (password: Momentum2026! — change after first login)
-- Generate bcrypt hashes at: https://bcrypt-generator.com
-- INSERT INTO dashboard_users (email, name, role, password_hash) VALUES
-- ('user@email.com', 'Name', 'viewer', 'bcrypt_hash_here');

-- Document Review Portal
CREATE TABLE documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  google_doc_url TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'pending',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE comments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  author_email TEXT NOT NULL,
  author_name TEXT,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE allowed_reviewers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  role TEXT DEFAULT 'reviewer',
  added_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE allowed_reviewers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON documents FOR ALL USING (true);
CREATE POLICY "service_role_all" ON comments FOR ALL USING (true);
CREATE POLICY "service_role_all" ON allowed_reviewers FOR ALL USING (true);
GRANT ALL ON documents TO service_role;
GRANT ALL ON comments TO service_role;
GRANT ALL ON allowed_reviewers TO service_role;

