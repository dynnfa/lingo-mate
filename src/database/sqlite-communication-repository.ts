import type Database from 'better-sqlite3'
import {
  TABLES,
  type CommunicationState,
  type CommunicationRepository
} from '../core/communication/communication-repository'

// Short synchronous IMMEDIATE transactions serialize claims across connections/processes.
// JSON records keep the platform independent contract local to Core; generated columns
// enforce relational ownership and uniqueness in SQLite as well.
export class SqliteCommunicationRepository implements CommunicationRepository {
  private closed = false
  constructor(private readonly database: Database.Database) {}
  close(): void {
    this.closed = true
  }
  private load(): CommunicationState {
    if (this.closed) throw new Error('Communication repository is closed')
    const state = {} as CommunicationState
    for (const table of TABLES) {
      const rows = this.database
        .prepare(`SELECT id, data FROM communication_${table}`)
        .all() as Array<{ id: string; data: string }>
      // Values never leave the trusted repository/Core boundary.
      Object.assign(state, { [table]: new Map(rows.map((row) => [row.id, JSON.parse(row.data)])) })
    }
    return state
  }
  read<T>(operation: (state: CommunicationState) => T): T {
    return this.database.transaction(() => operation(this.load()))()
  }
  transaction<T>(operation: (state: CommunicationState) => T): T {
    return this.database
      .transaction(() => {
        const state = this.load()
        const before = new Map(
          TABLES.map((table) => [
            table,
            new Map([...state[table]].map(([id, row]) => [id, JSON.stringify(row)]))
          ])
        )
        const result = operation(state)
        if (result instanceof Promise)
          throw new Error('Async communication transaction is forbidden')
        // Children first on deletion; parents first on insertion. Preserve IDs via UPSERT, never REPLACE.
        for (const table of [...TABLES].reverse()) {
          const remove = this.database.prepare(`DELETE FROM communication_${table} WHERE id = ?`)
          for (const id of before.get(table)!.keys()) if (!state[table].has(id)) remove.run(id)
        }
        for (const table of TABLES) {
          const upsert = this.database
            .prepare(`INSERT INTO communication_${table}(id, data) VALUES (?, ?)
          ON CONFLICT(id) DO UPDATE SET data = excluded.data`)
          for (const [id, row] of state[table]) {
            const data = JSON.stringify(row)
            if (before.get(table)!.get(id) !== data) upsert.run(id, data)
          }
        }
        return result
      })
      .immediate()
  }
}
