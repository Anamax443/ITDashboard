import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

async function ensureMigrationsTable(pool: Awaited<ReturnType<typeof getPool>>) {
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'schema_migrations')
    CREATE TABLE schema_migrations (
      id NVARCHAR(255) PRIMARY KEY,
      applied_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
  `);
}

async function appliedMigrations(pool: Awaited<ReturnType<typeof getPool>>): Promise<Set<string>> {
  const r = await pool.request().query<{ id: string }>('SELECT id FROM schema_migrations');
  return new Set(r.recordset.map((x) => x.id));
}

async function main() {
  const pool = await getPool();
  await ensureMigrationsTable(pool);
  const applied = await appliedMigrations(pool);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  for (const f of files) {
    if (applied.has(f)) continue;
    const sqlText = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
    console.log(`Applying migration ${f}…`);
    const tx = pool.transaction();
    await tx.begin();
    try {
      await tx.request().batch(sqlText);
      await tx.request().input('id', f).query('INSERT INTO schema_migrations (id) VALUES (@id)');
      await tx.commit();
      console.log(`  ✓ ${f}`);
    } catch (err) {
      await tx.rollback();
      console.error(`  ✗ ${f}:`, err);
      process.exit(1);
    }
  }

  console.log('Migrations done.');
  await pool.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
