-- Custom SQL migration file, put your code below! --
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='id',
  tokenize='unicode61'
);
--> statement-breakpoint

CREATE TRIGGER chunks_fts_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text)
  VALUES (new.id, new.text);
END;
--> statement-breakpoint

CREATE TRIGGER chunks_fts_delete AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text)
  VALUES ('delete', old.id, old.text);
END;
--> statement-breakpoint

CREATE TRIGGER chunks_fts_update AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text)
  VALUES ('delete', old.id, old.text);

  INSERT INTO chunks_fts(rowid, text)
  VALUES (new.id, new.text);
END;
--> statement-breakpoint

INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild');
