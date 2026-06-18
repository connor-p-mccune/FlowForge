const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../../data/flowforge.db')

const dbDir = path.dirname(DB_PATH)
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true })
}

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8')
db.exec(schema)

// Lightweight additive migrations. better-sqlite3 has no migration framework and
// schema.sql uses CREATE TABLE IF NOT EXISTS, so columns added after a database
// already exists are applied here: ALTER only when the column is missing, so
// existing dev/prod databases pick up new fields without a wipe.
function ensureColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

// Phase 8 (analytics): node_type denormalises each step's node type at run time so
// per-type timing survives later edits to the workflow graph. Indexed for the
// node-usage aggregate. Created here (not in schema.sql) so the index can be built
// only after the column exists on pre-existing databases.
ensureColumn('execution_steps', 'node_type', 'TEXT')
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_execution_steps_exec_type
    ON execution_steps (execution_id, node_type);
`)

// Execution replay: trigger_data persists the original trigger payload (webhook
// body, manual/schedule metadata) as JSON so a past run can be re-run with the
// identical input; trigger_type records how the run was started
// ('manual' | 'webhook' | 'schedule' | 'replay'). triggered_by stays the user FK
// (who, if anyone, started it) — replays carry the user who clicked Replay, so a
// dedicated trigger_type column marks them without breaking that foreign key.
ensureColumn('executions', 'trigger_data', 'TEXT')
ensureColumn('executions', 'trigger_type', 'TEXT')

module.exports = db
