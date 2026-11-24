import { createApp } from './app';
import { closeDatabase } from './database/client';
import { env } from './shared/config/env';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`API ouvindo na porta ${env.PORT}`);
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`${signal} recebido, encerrando a API`);
  server.close(async (error) => {
    await closeDatabase();
    if (error) {
      console.error(error);
      process.exit(1);
    }
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
