import { Client } from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../src/database/migrator';

async function createDatabaseIfMissing(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl);
  const databaseName = url.pathname.slice(1);
  url.pathname = '/postgres';

  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (rowCount === 0) {
      await client.query(`CREATE DATABASE "${databaseName}"`);
    }
  } finally {
    await client.end();
  }
}

export default async function setup(project: TestProject): Promise<void> {
  const databaseUrl = project.config.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL de teste não definida no vitest.config.mts');
  }

  await createDatabaseIfMissing(databaseUrl);
  await runMigrations(databaseUrl);
}
