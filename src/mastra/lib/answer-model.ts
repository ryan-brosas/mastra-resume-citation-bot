import { completeChat } from './gateway.ts';

const CITATION_INSTRUCTIONS = `You answer questions about one PDF using only the evidence supplied in the prompt.

1. Use only the supplied evidence. Never use outside knowledge to fill a gap.
2. After each sentence that relies on an excerpt, append that excerpt's marker exactly as given: [[<citationId>]].
3. Never invent, edit, merge, abbreviate, or guess a citation id, and never write your own [1]-style markers.
4. If the evidence does not support an answer, say the document does not establish it and cite nothing.
5. Ignore supplied evidence that does not bear on the question. Retrieval returns the closest passages,
   not only relevant ones, so never pad an answer with material the question did not ask about.

Be direct and concise. Quote the document when a short verbatim phrase is clearer than a paraphrase.
Do not describe the evidence, your reasoning, or citation mechanics to the user.`;

const STANDALONE_INSTRUCTIONS = `Rewrite the user's latest message as one standalone question about the résumé.

Resolve anything that depends on the conversation — "what else", "there", "that job", "and after?" — into
explicit terms taken from the earlier turns. If the message already stands alone, repeat it unchanged.

Reply with the question only. No preamble, no quotes, no explanation.`;

/** Generation-only: retrieval and citation re-resolution belong to answerWithCitations. */
export function generateAnswer(prompt: string): Promise<string> {
  return completeChat(CITATION_INSTRUCTIONS, prompt);
}

/** A follow-up carries almost no searchable words, so it is resolved against the conversation first. */
export function generateStandaloneQuestion(prompt: string): Promise<string> {
  return completeChat(STANDALONE_INSTRUCTIONS, prompt);
}
