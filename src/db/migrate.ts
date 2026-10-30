import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const migrationsPath = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));

try {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_id TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const files = (await readdir(migrationsPath)).filter((file) => file.endsWith('.sql')).sort();

  for (const file of files) {
    const alreadyApplied = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE migration_id = $1', [file],
    );
    if (alreadyApplied.rowCount) continue;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sql = await readFile(new URL(`../../src/db/migrations/${file}`, import.meta.url), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (migration_id) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`Applied database migration ${file}.`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
