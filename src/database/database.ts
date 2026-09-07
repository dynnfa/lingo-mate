import Database from 'better-sqlite3'
import { migrateDatabase } from './migrations'

// The application owns this connection; repositories neither migrate nor close it.
export function openDatabase(path: string): Database.Database {
  const database = new Database(path)
  try {
    database.pragma('journal_mode = WAL')
    database.pragma('foreign_keys = ON')
    migrateDatabase(database)
    return database
  } catch (cause) {
    database.close()
    throw cause
  }
}
