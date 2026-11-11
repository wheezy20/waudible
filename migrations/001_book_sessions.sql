CREATE TABLE IF NOT EXISTS book_sessions (
    book_name    TEXT PRIMARY KEY,
    current_page INTEGER          NOT NULL DEFAULT 0,
    speed        DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    voice        TEXT             NOT NULL DEFAULT 'af_heart',
    genre        TEXT             NOT NULL DEFAULT 'Other',
    cover        TEXT,
    updated_at   TIMESTAMPTZ      NOT NULL DEFAULT now()
);
