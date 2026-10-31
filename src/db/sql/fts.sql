
-- Create FTS5 index if missing
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='id',
  tokenize='unicode61'
);
--> statement-breakpoint

-- Remove old triggers
DROP TRIGGER IF EXISTS chunks_fts_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS chunks_fts_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS chunks_fts_update;
--> statement-breakpoint

-- Insert
CREATE TRIGGER chunks_fts_insert
AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text)
  VALUES (new.id, new.text);
END;
--> statement-breakpoint

-- Delete
CREATE TRIGGER chunks_fts_delete
AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text)
  VALUES ('delete', old.id, old.text);
END;
--> statement-breakpoint

-- Update
CREATE TRIGGER chunks_fts_update
AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text)
  VALUES ('delete', old.id, old.text);

  INSERT INTO chunks_fts(rowid, text)
  VALUES (new.id, new.text);
END;
--> statement-breakpoint

-- Rebuild from the canonical chunks table
INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild');
