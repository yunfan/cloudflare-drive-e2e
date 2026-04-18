-- If updating an existing database, run this manually:
-- ALTER TABLE files ADD COLUMN storage_backend TEXT DEFAULT 'KV';

CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'file',
    parent_id TEXT,
    size INTEGER DEFAULT 0,
    total_chunks INTEGER DEFAULT 0,
    salt TEXT,
    chunk_prefix TEXT,
    storage_backend TEXT DEFAULT 'KV',
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS d1_chunks (
    chunk_key TEXT PRIMARY KEY,
    chunk_data BLOB NOT NULL
);
