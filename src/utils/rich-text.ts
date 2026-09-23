import { z } from 'zod';

export type RichTextMark = { type: 'bold' | 'italic' } | { type: 'link'; attrs: { href: string } };
export type RichTextNode = {
  type: 'paragraph' | 'heading' | 'bulletList' | 'orderedList' | 'listItem' | 'blockquote' | 'text';
  attrs?: { level?: 2 | 3; start?: number };
  content?: RichTextNode[];
  text?: string;
  marks?: RichTextMark[];
};
export type RichTextDocument = { type: 'doc'; content: RichTextNode[] };

const maxNodes = 2000;
const maxDepth = 12;
const maxTextLength = 40000;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label} contains unsupported fields`);
}

function httpsUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2000) throw new Error('Link must use HTTPS');
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('Link must be a valid HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Link must use HTTPS without embedded credentials');
  return url.toString();
}

function parseMarks(value: unknown): RichTextMark[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 3) throw new Error('Text formatting is invalid');
  const marks = value.map(raw => {
    const mark = record(raw, 'Text mark');
    exactKeys(mark, ['type', 'attrs'], 'Text mark');
    if (mark.type === 'bold' || mark.type === 'italic') {
      if (mark.attrs !== undefined && Object.keys(record(mark.attrs, 'Text mark attributes')).length) throw new Error('Text mark attributes are invalid');
      return { type: mark.type } as RichTextMark;
    }
    if (mark.type === 'link') {
      const attrs = record(mark.attrs, 'Link attributes');
      exactKeys(attrs, ['href', 'target', 'rel', 'class', 'title'], 'Link attributes');
      return { type: 'link', attrs: { href: httpsUrl(attrs.href) } } as RichTextMark;
    }
    throw new Error('Text formatting is not supported');
  });
  if (new Set(marks.map(mark => mark.type)).size !== marks.length) throw new Error('Duplicate text formatting is not allowed');
  return marks.length ? marks : undefined;
}

function parseDocument(value: unknown): RichTextDocument {
  let nodes = 0;
  let textLength = 0;
  const visit = (raw: unknown, depth: number, parent: string): RichTextNode => {
    if (depth > maxDepth) throw new Error('Rich text is nested too deeply');
    if (++nodes > maxNodes) throw new Error('Rich text has too many nodes');
    const node = record(raw, 'Rich text node');
    if (typeof node.type !== 'string') throw new Error('Rich text node type is required');
    const nodeType = node.type;
    if (nodeType === 'text') {
      exactKeys(node, ['type', 'text', 'marks'], 'Text node');
      if (!['paragraph', 'heading'].includes(parent) || typeof node.text !== 'string' || !node.text.length) throw new Error('Text node is invalid');
      textLength += node.text.length;
      if (textLength > maxTextLength) throw new Error('Rich text exceeds 40,000 characters');
      const marks = parseMarks(node.marks);
      return { type: 'text', text: node.text, ...(marks ? { marks } : {}) };
    }
    if (!['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote'].includes(nodeType)) throw new Error('Rich text node type is not supported');
    exactKeys(node, ['type', 'attrs', 'content'], 'Rich text node');
    if (!Array.isArray(node.content) || node.content.length > 1000) throw new Error('Rich text node content is invalid');
    if (node.type === 'paragraph' || node.type === 'heading') {
      const attrs = node.attrs === undefined ? {} : record(node.attrs, 'Text block attributes');
      if (node.type === 'paragraph') exactKeys(attrs, [], 'Paragraph attributes');
      else {
        exactKeys(attrs, ['level'], 'Heading attributes');
        if (attrs.level !== 2 && attrs.level !== 3) throw new Error('Only heading levels 2 and 3 are supported');
      }
      const content = node.content.map(child => visit(child, depth + 1, nodeType));
      if (content.some(child => child.type !== 'text')) throw new Error('Text blocks may only contain text');
      return { type: node.type, ...(node.type === 'heading' ? { attrs: { level: attrs.level as 2 | 3 } } : {}), ...(content.length ? { content } : {}) } as RichTextNode;
    }
    if (node.type === 'bulletList' || node.type === 'orderedList') {
      if (!node.content.length) throw new Error('Lists cannot be empty');
      const attrs = node.attrs === undefined ? {} : record(node.attrs, 'List attributes');
      if (node.type === 'bulletList') exactKeys(attrs, [], 'Bullet list attributes');
      else {
        exactKeys(attrs, ['start', 'type'], 'Ordered list attributes');
        if (attrs.start !== undefined && (!Number.isInteger(attrs.start) || Number(attrs.start) < 1 || Number(attrs.start) > 100000)) throw new Error('Ordered list start is invalid');
        if (attrs.type !== undefined && attrs.type !== null && attrs.type !== '1') throw new Error('Ordered list type is not supported');
      }
      const content = node.content.map(child => visit(child, depth + 1, nodeType));
      if (content.some(child => child.type !== 'listItem')) throw new Error('Lists may only contain list items');
      const start = node.type === 'orderedList' && typeof attrs.start === 'number' && attrs.start !== 1 ? attrs.start : undefined;
      return { type: node.type, ...(start ? { attrs: { start } } : {}), content };
    }
    if (node.type === 'listItem') {
      if (!['bulletList', 'orderedList'].includes(parent) || !node.content.length) throw new Error('List item is invalid');
      const attrs = node.attrs === undefined ? {} : record(node.attrs, 'List item attributes');
      exactKeys(attrs, [], 'List item attributes');
      const content = node.content.map(child => visit(child, depth + 1, nodeType));
      if (content[0]?.type !== 'paragraph' || content.some(child => !['paragraph', 'bulletList', 'orderedList'].includes(child.type))) throw new Error('List item structure is invalid');
      return { type: 'listItem', content };
    }
    const attrs = node.attrs === undefined ? {} : record(node.attrs, 'Blockquote attributes');
    exactKeys(attrs, [], 'Blockquote attributes');
    const content = node.content.map(child => visit(child, depth + 1, nodeType));
    if (!content.length || content.some(child => !['paragraph', 'heading', 'bulletList', 'orderedList'].includes(child.type))) throw new Error('Blockquote structure is invalid');
    return { type: 'blockquote', content };
  };
  const document = record(value, 'Rich text document');
  exactKeys(document, ['type', 'content'], 'Rich text document');
  if (document.type !== 'doc' || !Array.isArray(document.content) || document.content.length > 1000) throw new Error('Rich text document is invalid');
  const content = document.content.map(node => visit(node, 1, 'doc'));
  if (content.some(node => node.type === 'text' || node.type === 'listItem')) throw new Error('Rich text document contains an invalid top-level node');
  return { type: 'doc', content };
}

export const richTextDocumentSchema = z.record(z.string(), z.unknown()).transform((value, context) => {
  try { return parseDocument(value); }
  catch (error) {
    context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Rich text is invalid' });
    return z.NEVER;
  }
});

function nodeText(node: RichTextNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'paragraph' || node.type === 'heading') return (node.content ?? []).map(nodeText).join('');
  if (node.type === 'listItem') return (node.content ?? []).map(nodeText).filter(Boolean).join('\n');
  if (node.type === 'bulletList') return (node.content ?? []).map(item => `• ${nodeText(item)}`).join('\n');
  if (node.type === 'orderedList') {
    const start = node.attrs?.start ?? 1;
    return (node.content ?? []).map((item, index) => `${start + index}. ${nodeText(item)}`).join('\n');
  }
  if (node.type === 'blockquote') return (node.content ?? []).map(nodeText).join('\n').split('\n').map(line => `> ${line}`).join('\n');
  return '';
}

export function richTextToPlainText(document: RichTextDocument) {
  return document.content.map(nodeText).filter(Boolean).join('\n\n').trim();
}
