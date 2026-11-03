import type Database from 'better-sqlite3'
// Additive only. Never opens a database; the application controls migration consent.
export function migrateCommunication(database: Database.Database): void {
  database.exec(`
    CREATE TABLE communication_connections (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE TABLE communication_challenges (
      id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)),
      connection_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.connectionId')) STORED NOT NULL REFERENCES communication_connections(id)
    );
    CREATE TABLE communication_bindings (
      id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)),
      connection_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.connectionId')) STORED NOT NULL REFERENCES communication_connections(id)
    );
    CREATE UNIQUE INDEX communication_binding_actor ON communication_bindings(connection_id, json_extract(data, '$.externalActorId'))
      WHERE json_extract(data, '$.revoked') = 0;
    CREATE TABLE communication_sessions (
      id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)),
      connection_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.connectionId')) STORED NOT NULL REFERENCES communication_connections(id),
      binding_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.bindingId')) STORED NOT NULL REFERENCES communication_bindings(id),
      session_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.sessionId')) STORED NOT NULL UNIQUE REFERENCES conversations(id)
    );
    CREATE UNIQUE INDEX communication_session_active ON communication_sessions(binding_id,
      json_extract(data, '$.route.externalConversationId'), coalesce(json_extract(data, '$.route.externalThreadId'), ''),
      json_extract(data, '$.languages.targetLanguage')) WHERE json_extract(data, '$.active') = 1;
    CREATE TABLE communication_inbox (
      id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)),
      connection_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.connectionId')) STORED NOT NULL REFERENCES communication_connections(id),
      event_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.eventId')) STORED NOT NULL,
      session_ref TEXT GENERATED ALWAYS AS (json_extract(data, '$.sessionRef')) STORED REFERENCES communication_sessions(id),
      UNIQUE(connection_id, event_id)
    );
    CREATE TABLE communication_confirmations (
      id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)),
      binding_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.bindingId')) STORED NOT NULL REFERENCES communication_bindings(id),
      session_ref TEXT GENERATED ALWAYS AS (json_extract(data, '$.sessionRef')) STORED NOT NULL REFERENCES communication_sessions(id)
    );
    CREATE TABLE communication_outbox (
      id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)),
      connection_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.connectionId')) STORED NOT NULL REFERENCES communication_connections(id),
      binding_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.bindingId')) STORED NOT NULL REFERENCES communication_bindings(id),
      request_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.requestId')) STORED NOT NULL UNIQUE
    );
  `)
}
