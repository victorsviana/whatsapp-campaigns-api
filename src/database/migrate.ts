import { env } from '../shared/config/env';
import { runMigrations } from './migrator';

runMigrations(env.DATABASE_URL)
  .then(() => {
    console.log('Migrations aplicadas');
  })
  .catch((error: unknown) => {
    console.error('Falha ao aplicar migrations', error);
    process.exit(1);
  });
