import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { PinoLogger } from '@mastra/loggers';
import { DATABASE_URL, vectorStore } from './lib/vector-store.ts';
import { askRoutes } from './routes.ts';
import { indexDocumentWorkflow } from './workflows/index-document.ts';

/**
 * The answer model is deliberately not registered as a caller-facing agent: reaching it directly
 * would return raw model citations that never pass through answerWithCitations' re-resolution.
 */
export const mastra = new Mastra({
  workflows: { indexDocumentWorkflow },
  vectors: { vectorStore },
  storage: new LibSQLStore({ id: 'mastra-storage', url: DATABASE_URL }),
  logger: new PinoLogger({ name: 'ryans-resume-bot', level: 'info' }),
  server: { apiRoutes: askRoutes },
});

export { answerWithCitations, AnswerError } from './boundary.ts';
