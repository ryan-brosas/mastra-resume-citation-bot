import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { DEFAULT_SOURCE_PATH } from '../../citations/manifest.ts';
import { indexDocument } from '../indexing.ts';

const inputSchema = z.object({
  sourcePath: z.string().default(DEFAULT_SOURCE_PATH).describe('Local path to the PDF to index'),
});

const outputSchema = z.object({
  version: z.string(),
  documentId: z.string(),
  indexedCitations: z.number(),
});

const indexDocumentStep = createStep({
  id: 'index-document',
  description:
    'Rebuild the verified citation manifest, embed it only if it is too large to answer whole, then publish',
  inputSchema,
  outputSchema,
  execute: ({ inputData: { sourcePath } }) => indexDocument(sourcePath),
});

const indexDocumentWorkflow = createWorkflow({ id: 'index-document', inputSchema, outputSchema }).then(indexDocumentStep);

indexDocumentWorkflow.commit();

export { indexDocumentWorkflow };
