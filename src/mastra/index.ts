import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { PinoLogger } from '@mastra/loggers';
import { DATABASE_URL, vectorStore } from './lib/vector-store.ts';
import { askRoutes } from './routes.ts';
import { indexDocumentWorkflow } from './workflows/index-document.ts';

function serverHost(): string {
  const host = process.env.MASTRA_HOST ?? '127.0.0.1';
  const loopback = host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.');
  if (!loopback && process.env.RESUME_BOT_ALLOW_PUBLIC !== 'true') {
    throw new Error('Set RESUME_BOT_ALLOW_PUBLIC=true only behind authenticated, rate-limited access control');
  }
  return host;
}

/**
 * The answer model is deliberately not registered as a caller-facing agent: reaching it directly
 * would return raw model citations that never pass through answerWithCitations' re-resolution.
 */
export const mastra = new Mastra({
  workflows: { indexDocumentWorkflow },
  vectors: { vectorStore },
  storage: new LibSQLStore({ id: 'mastra-storage', url: DATABASE_URL }),
  logger: new PinoLogger({ name: 'ryans-resume-bot', level: 'info', prettyPrint: process.env.NODE_ENV !== 'production' }),
  server: { host: serverHost(), cors: false, apiRoutes: askRoutes },
});

export { answerWithCitations, AnswerError } from './boundary.ts';
