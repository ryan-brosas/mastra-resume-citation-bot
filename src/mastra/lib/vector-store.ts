import { resolve } from 'node:path';
import { LibSQLVector } from '@mastra/libsql';
import { PROJECT_ROOT } from '../../citations/manifest.ts';

/** Anchored rather than relative: the dev server runs from src/mastra/public, not the project root. */
export const DATABASE_URL = process.env.PDF_CITATION_DB ?? `file:${resolve(PROJECT_ROOT, 'mastra.db')}`;

export const vectorStore = new LibSQLVector({ id: 'citation-vectors', url: DATABASE_URL });

export const CITATION_INDEX_NAME = 'document_citations';
