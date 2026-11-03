import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { MIGRATIONS, migrateDatabase } from '../migrations'
import { SqliteCommunicationRepository } from '../sqlite-communication-repository'
it('adds only communication structures to v14, preserves history and enforces foreign keys and event uniqueness', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys=ON')
    for (const m of MIGRATIONS.filter((m) => m.version <= 14)) m.up(db)
    db.pragma('user_version=14')
    const session = randomUUID(),
      stamp = new Date().toISOString()
    db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?)').run(
      session,
      stamp,
      stamp,
      'Existing'
    )
    migrateDatabase(db)
    expect(db.prepare('SELECT title FROM conversations WHERE id=?').get(session)).toEqual({
      title: 'Existing'
    })
    const repository = new SqliteCommunicationRepository(db)
    const connectionId = randomUUID()
    repository.transaction((s) =>
      s.connections.set(connectionId, {
        id: connectionId,
        adapterId: 'test',
        enabled: true,
        state: 'stopped',
        generation: 0,
        config: {},
        attempts: 0,
        cursorVersion: 0
      })
    )
    const inbox = {
      connectionId,
      eventId: 'duplicate',
      digest: 'digest',
      receipt: { status: 'persisted' },
      state: 'queued',
      receivedAt: 0,
      expiresAt: 1,
      actorId: 'actor',
      scopeKey: 'scope',
      control: false
    }
    db.prepare('INSERT INTO communication_inbox(id,data) VALUES (?,?)').run(
      randomUUID(),
      JSON.stringify(inbox)
    )
    expect(() =>
      db
        .prepare('INSERT INTO communication_inbox(id,data) VALUES (?,?)')
        .run(randomUUID(), JSON.stringify(inbox))
    ).toThrow('UNIQUE')
    expect(() =>
      db
        .prepare('INSERT INTO communication_sessions(id,data) VALUES (?,?)')
        .run(
          randomUUID(),
          JSON.stringify({ sessionId: randomUUID(), connectionId, bindingId: randomUUID() })
        )
    ).toThrow('FOREIGN KEY')
    expect(() =>
      repository.transaction((s) => {
        s.connections.get(connectionId)!.cursor = 'must rollback'
        throw new Error('disk failure')
      })
    ).toThrow('disk failure')
    expect(repository.read((s) => s.connections.get(connectionId)!.cursor)).toBeUndefined()
    expect(db.pragma('foreign_key_check')).toEqual([])
  } finally {
    db.close()
  }
})
