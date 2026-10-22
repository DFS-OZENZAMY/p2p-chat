CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Abonnements aux notifications push (un par appareil)
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs(user_id);

-- Messages chiffrés de bout en bout en attente pour un destinataire hors ligne (supprimés à réception)
CREATE TABLE IF NOT EXISTS mailbox (
  to_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  ct TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (to_id, msg_id)
);
CREATE INDEX IF NOT EXISTS mailbox_age ON mailbox(created_at);
