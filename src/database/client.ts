import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../shared/config/env';

export const pool = new Pool({ connectionString: env.DATABASE_URL });

pool.on('error', (error) => {
  console.error('Erro inesperado em conexão ociosa do Postgres', error);
});

export const db = drizzle(pool);

export type Database = typeof db;

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
