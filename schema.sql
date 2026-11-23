CREATE TABLE IF NOT EXISTS agreements (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL,
 details BLOB NOT NULL, original BLOB NOT NULL, final BLOB,
 status TEXT NOT NULL CHECK(status IN ('Sent','Viewed','Signed'))
);
CREATE TABLE IF NOT EXISTS attempts (
 id TEXT PRIMARY KEY, agreement TEXT NOT NULL REFERENCES agreements(id),
 expires INTEGER NOT NULL, last_event TEXT UNIQUE, evidence BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
 seq INTEGER PRIMARY KEY, agreement TEXT NOT NULL REFERENCES agreements(id),
 entry BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_agreement ON audit(agreement,seq);
