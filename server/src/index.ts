import { startServer } from './server';

async function main() {
  const { stop } = await startServer();

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down...`);
    await stop();
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
