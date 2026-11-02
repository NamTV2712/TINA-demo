import { expect, it } from 'vitest';
import { remarkWikiLinks } from '../src/components/workspace/wiki-links';

it('makes prose wikilinks navigable without rewriting code or existing links', () => {
  const code = { type: 'code', value: '[[Code stays]]' };
  const link = { type: 'link', url: 'https://example.test', children: [{ type: 'text', value: '[[Existing link]]' }] };
  const paragraph = { type: 'paragraph', children: [{ type: 'text', value: 'See [[Demo]] now.' }] };
  const tree = { type: 'root', children: [paragraph, code, link] };
  remarkWikiLinks()(tree);
  expect(paragraph.children).toEqual([{ type: 'text', value: 'See ' }, { type: 'link', url: '#knowledge=Demo', children: [{ type: 'text', value: 'Demo' }] }, { type: 'text', value: ' now.' }]);
  expect(code.value).toBe('[[Code stays]]');
  expect(link.children[0].value).toBe('[[Existing link]]');
});

it('keeps a moved wikilink alias while navigating its encoded destination', () => {
  const paragraph = { type: 'paragraph', children: [{ type: 'text', value: '[[notes/new%20plan.md#decision|Budget]]' }] };
  remarkWikiLinks()(paragraph);
  expect(paragraph.children).toEqual([{ type: 'link', url: '#knowledge=notes%2Fnew%2520plan.md%23decision', children: [{ type: 'text', value: 'Budget' }] }]);
});
