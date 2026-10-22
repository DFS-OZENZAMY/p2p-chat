CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
