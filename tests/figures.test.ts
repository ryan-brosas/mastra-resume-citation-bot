import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claims, groundFigures } from '../src/citations/figures.ts';

const excerpt = 'Trained a new QA from scratch, and raised campaign quality by 20 to 30% using data.';
const blog = 'Grew the blog to 915,000 Google search impressions and 1,690 clicks, average position 8.1.';
const from = (map: Record<number, string>) => (position: number) => map[position];

test('a claim keeps its citation when every figure appears in the cited passage', () => {
  const result = groundFigures('He raised campaign quality by 20 to 30%. [1]', from({ 1: excerpt }));

  assert.equal(result.text, 'He raised campaign quality by 20 to 30%. [1]');
  assert.deepEqual(result.unsupported, []);
});

test('a figure the cited passage does not contain loses its citation and is reported', () => {
  const result = groundFigures('He managed 42 engineers and raised quality by 95%. [1]', from({ 1: excerpt }));

  assert.doesNotMatch(result.text, /\[1\]/, 'an unsupported claim must not look evidenced');
  assert.match(result.text, /He managed 42 engineers/, 'the sentence itself is left for the reader to judge');
  assert.deepEqual(result.unsupported, ['42', '95']);
});

test('only the offending claim loses its citation', () => {
  const result = groundFigures(
    'He raised quality by 20 to 30%. [1] He also managed 42 engineers. [1]',
    from({ 1: excerpt }),
  );

  assert.match(result.text, /quality by 20 to 30%\. \[1\]/, 'the supported claim keeps its marker');
  assert.doesNotMatch(result.text, /42 engineers\. \[1\]/);
  assert.deepEqual(result.unsupported, ['42']);
});

test('thousands separators and trailing zeros do not read as fabrication', () => {
  const result = groundFigures('The blog reached 915,000 impressions and 1,690 clicks. [1]', from({ 1: blog }));

  assert.match(result.text, /\[1\]/);
  assert.deepEqual(result.unsupported, []);
});

test('a decimal is matched exactly, not loosely', () => {
  const ok = groundFigures('Average position was 8.1. [1]', from({ 1: blog }));
  assert.deepEqual(ok.unsupported, []);

  const drifted = groundFigures('Average position was 8.7. [1]', from({ 1: blog }));
  assert.deepEqual(drifted.unsupported, ['8.7']);
});

test('a figure supported by any one of several cited passages is accepted', () => {
  const result = groundFigures('He did both, reaching 915,000 and 30%. [1] [2]', from({ 1: blog, 2: excerpt }));
  assert.deepEqual(result.unsupported, []);
});

test('an uncited sentence is left exactly as written', () => {
  const result = groundFigures('The résumé does not establish that.', from({}));

  assert.equal(result.text, 'The résumé does not establish that.');
  assert.deepEqual(result.unsupported, []);
});

test('the citation markers themselves are never read as figures', () => {
  const result = groundFigures('Quality rose 20 to 30%. [1]', from({ 1: excerpt }));
  assert.deepEqual(result.unsupported, [], 'the "1" in [1] must not count as a stated figure');
});

test('claims split on sentence ends and on trailing markers', () => {
  assert.deepEqual(claims('One. [1] Two. [2]'), ['One. [1]', 'Two. [2]']);
  assert.deepEqual(claims('Alpha [1]. Beta [2].'), ['Alpha [1].', 'Beta [2].']);
});

const money = 'Closed 700+ deals worth $1,250,000 and grew store sales by 70% in Q4 2019.';

test('a rounded restatement is reported, because only exact figures are checked', () => {
  const exact = groundFigures('The blog reached 915,000 impressions. [1]', from({ 1: blog }));
  assert.deepEqual(exact.unsupported, []);

  // Deliberate: 'about 900,000' is a fair paraphrase, but this check cannot tell it from a fabrication.
  const rounded = groundFigures('The blog reached about 900,000 impressions. [1]', from({ 1: blog }));
  assert.deepEqual(rounded.unsupported, ['900000']);
  assert.doesNotMatch(rounded.text, /\[1\]/);
});

test('a hyphenated range matches a written one, since both sides are read as figures', () => {
  const enDash = groundFigures('Quality rose 20–30%. [1]', from({ 1: excerpt }));
  assert.deepEqual(enDash.unsupported, []);

  const hyphen = groundFigures('Quality rose 20-30%. [1]', from({ 1: excerpt }));
  assert.deepEqual(hyphen.unsupported, []);

  const widened = groundFigures('Quality rose 20-40%. [1]', from({ 1: money }));
  assert.deepEqual(widened.unsupported, ['20', '40']);
});

test('currency amounts are checked by their digits, not their symbol', () => {
  const kept = groundFigures('He closed deals worth $1,250,000. [1]', from({ 1: money }));
  assert.deepEqual(kept.unsupported, []);

  const altered = groundFigures('He closed deals worth $1,260,000. [1]', from({ 1: money }));
  assert.deepEqual(altered.unsupported, ['1260000']);
});

test('a date the passage does not carry loses its citation', () => {
  const kept = groundFigures('That was in Q4 2019. [1]', from({ 1: money }));
  assert.deepEqual(kept.unsupported, []);

  const wrong = groundFigures('That was in 2021. [1]', from({ 1: money }));
  assert.deepEqual(wrong.unsupported, ['2021']);
  assert.doesNotMatch(wrong.text, /\[1\]/);
});

test('a figure written without digits is not checked', () => {
  // Known boundary: 'seven hundred' is invisible to a digit-based check.
  const result = groundFigures('He closed seven hundred deals. [1]', from({ 1: money }));
  assert.deepEqual(result.unsupported, []);
  assert.match(result.text, /\[1\]/);
});
