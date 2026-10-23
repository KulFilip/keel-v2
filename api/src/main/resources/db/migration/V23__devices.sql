-- Phones paired with this keel (keel's Android app; docs: "Use keel from your phone"). A device signs in with
-- `Authorization: Bearer <device token>`; only the token's SHA-256 is kept here, never the token. Removing a device
-- deletes its row, so its token stops working at once.
CREATE TABLE devices (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    platform      TEXT NOT NULL,
    token_hash    TEXT NOT NULL UNIQUE,
    created_at    TEXT NOT NULL,
    last_seen_at  TEXT,
    last_ip       TEXT
);
