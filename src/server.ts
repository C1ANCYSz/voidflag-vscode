import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  MarkupKind,
  HoverParams,
  Hover,
  DocumentFormattingParams,
  TextEdit,
  Range,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseSchema, LexerError, ParseError } from '@voidflag/parser';

// ─── Completion items ─────────────────────────────────────────────────────────

type Context =
  | 'top-level'
  | 'field-name'
  | 'field-name-type-only'
  | 'field-name-fallback-only'
  | 'type-value'
  | 'fallback-value-bool'
  | 'fallback-value-any'
  | 'unknown';

function getContext(
  doc: TextDocument,
  pos: TextDocumentPositionParams['position'],
): Context {
  const lines = doc.getText().split('\n');
  const currentLine = lines[pos.line] ?? '';
  const textBeforeCursor = currentLine.slice(0, pos.character).trimStart();

  // ── After "type " → suggest type values ──────────────────────────────────
  if (/^type\s+\S*$/.test(textBeforeCursor)) return 'type-value';

  // ── After "fallback " → only suggest for bool, nothing for string/number ─
  if (/^fallback\s+/.test(textBeforeCursor)) {
    const flagType = getFlagTypeInBlock(lines, pos.line, pos.character);
    return flagType === 'bool' ? 'fallback-value-bool' : 'unknown';
  }

  // ── Are we inside a flag block? ───────────────────────────────────────────
  const blockStart = findBlockStart(lines, pos.line, pos.character);
  if (blockStart === -1) return 'top-level';

  // ── On a fresh line inside the block — suggest only missing fields ────────
  // Allow partial typing: "t", "ty", "type", "f", "fa" etc. should still
  // trigger suggestions. Only bail if the word isn't a prefix of either keyword.
  const partial = textBeforeCursor.trim();
  const isTypingField =
    partial === '' || 'type'.startsWith(partial) || 'fallback'.startsWith(partial);

  if (!isTypingField) return 'unknown';

  // Scan everything written in this block so far (previous lines only)
  const blockContent = lines.slice(blockStart + 1, pos.line).join(' ');
  const hasType = /\btype\s+(bool|string|number)\b/.test(blockContent);
  const hasFallback = /\bfallback\s+\S/.test(blockContent);

  if (!hasType && !hasFallback) return 'field-name';
  if (!hasType) return 'field-name-type-only';
  if (!hasFallback) return 'field-name-fallback-only';
  return 'unknown';
}

function findBlockStart(lines: string[], fromLine: number, fromChar?: number): number {
  let braceDepth = 0;
  for (let i = fromLine; i >= 0; i--) {
    const l = (lines[i] ?? '').trim();
    const end = i === fromLine && fromChar !== undefined ? fromChar : l.length;
    for (let j = end - 1; j >= 0; j--) {
      if (l[j] === '}') braceDepth++;
      if (l[j] === '{') {
        if (braceDepth === 0) return i;
        else braceDepth--;
      }
    }
  }
  return -1;
}

function getFlagTypeInBlock(
  lines: string[],
  fromLine: number,
  fromChar?: number,
): string {
  const blockStart = findBlockStart(lines, fromLine, fromChar);
  if (blockStart === -1) return 'unknown';
  // Check previous lines and the current line before cursor
  const linesToScan = [
    ...lines.slice(blockStart + 1, fromLine),
    (lines[fromLine] ?? '').slice(0, fromChar),
  ];
  for (const l of linesToScan) {
    const m = l.match(/\btype\s+(bool|string|number)\b/);
    if (m) return m[1]!;
  }
  return 'unknown';
}

const ITEMS: Record<Context, CompletionItem[]> = {
  'top-level': [
    {
      label: 'flag',
      kind: CompletionItemKind.Keyword,
      detail: 'Declare a feature flag',
      documentation: {
        kind: MarkupKind.Markdown,
        value:
          'Declares a new feature flag.\n\n```vf\nflag myFlag {\n  type bool\n  fallback false\n}\n```',
      },
    },
  ],
  'field-name': [
    {
      label: 'type',
      kind: CompletionItemKind.Property,
      detail: 'Set the flag type',
      documentation: {
        kind: MarkupKind.Markdown,
        value: 'Must be `bool`, `string`, or `number`.',
      },
    },
    {
      label: 'fallback',
      kind: CompletionItemKind.Property,
      detail: 'Set the fallback value',
      documentation: {
        kind: MarkupKind.Markdown,
        value: 'The value used when the flag is disabled or unreachable.',
      },
    },
  ],
  'type-value': [
    {
      label: 'bool',
      kind: CompletionItemKind.TypeParameter,
      detail: 'Boolean flag type',
    },
    {
      label: 'string',
      kind: CompletionItemKind.TypeParameter,
      detail: 'String flag type',
    },
    {
      label: 'number',
      kind: CompletionItemKind.TypeParameter,
      detail: 'Number flag type',
    },
  ],
  'fallback-value-bool': [
    { label: 'true', kind: CompletionItemKind.Value, detail: 'Boolean true' },
    { label: 'false', kind: CompletionItemKind.Value, detail: 'Boolean false' },
  ],
  'fallback-value-any': [
    { label: 'true', kind: CompletionItemKind.Value, detail: 'Boolean true' },
    { label: 'false', kind: CompletionItemKind.Value, detail: 'Boolean false' },
  ],
  'field-name-type-only': [
    {
      label: 'type',
      kind: CompletionItemKind.Property,
      detail: 'Set the flag type',
      documentation: {
        kind: MarkupKind.Markdown,
        value: 'Must be `bool`, `string`, or `number`.',
      },
    },
  ],
  'field-name-fallback-only': [
    {
      label: 'fallback',
      kind: CompletionItemKind.Property,
      detail: 'Set the fallback value',
      documentation: {
        kind: MarkupKind.Markdown,
        value: 'The value used when the flag is disabled or unreachable.',
      },
    },
  ],
  unknown: [],
};

// ─── Hover info ───────────────────────────────────────────────────────────────

const HOVER_DOCS: Record<string, string> = {
  flag: '**flag** — declares a new feature flag.\n\n```vf\nflag myFlag {\n  type bool\n  fallback false\n}\n```',
  type: '**type** — the data type of this flag.\n\nAccepted values: `bool`, `string`, `number`',
  fallback:
    '**fallback** — the value used when the flag is disabled or the SDK cannot reach the server.',
  bool: '**bool** — a boolean flag. Fallback must be `true` or `false`.',
  string: '**string** — a string flag. Fallback must be a quoted string, e.g. `"hello"`.',
  number:
    '**number** — a numeric flag. Fallback must be an integer or decimal, e.g. `16` or `3.14`.',
  true: '**true** — boolean literal.',
  false: '**false** — boolean literal.',
};

function wordAt(line: string, character: number): string {
  let start = character,
    end = character;
  while (start > 0 && /\w/.test(line[start - 1]!)) start--;
  while (end < line.length && /\w/.test(line[end]!)) end++;
  return line.slice(start, end);
}

// ─── LSP setup ────────────────────────────────────────────────────────────────

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

connection.onInitialize(
  (_params: InitializeParams): InitializeResult => ({
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { resolveProvider: false },
      hoverProvider: true,
      documentFormattingProvider: true,
    },
  }),
);

// ─── Diagnostics ──────────────────────────────────────────────────────────────

function validate(doc: TextDocument): void {
  const source = doc.getText();
  const diagnostics: Diagnostic[] = [];

  try {
    parseSchema(source);
  } catch (err) {
    if (err instanceof LexerError || err instanceof ParseError) {
      const line = err.line - 1;
      const col = err.col - 1;
      const lineText = source.split('\n')[line] ?? '';
      let end = col;
      while (end < lineText.length && !/[\s{}]/.test(lineText[end]!)) end++;
      if (end === col) end = col + 1;
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: { start: { line, character: col }, end: { line, character: end } },
        message: err.message,
        source: 'voidflag',
      });
    }
  }

  connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

documents.onDidOpen((e) => validate(e.document));
documents.onDidChangeContent((e) => validate(e.document));
documents.onDidClose((e) =>
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] }),
);

// ─── Completion ───────────────────────────────────────────────────────────────

connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return ITEMS[getContext(doc, params.position)] ?? [];
});

// ─── Hover ────────────────────────────────────────────────────────────────────

connection.onHover((params: HoverParams): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const lines = doc.getText().split('\n');
  const line = lines[params.position.line] ?? '';
  const word = wordAt(line, params.position.character);
  const docs = HOVER_DOCS[word];
  if (!docs) return null;
  return { contents: { kind: MarkupKind.Markdown, value: docs } };
});

// ─── Formatter ───────────────────────────────────────────────────────────────

function formatVf(source: string): string {
  // Don't format if the file has errors
  let ast;
  try {
    ast = parseSchema(source);
  } catch {
    return source;
  }

  if (ast.flags.length === 0) return source;

  return (
    ast.flags
      .map(
        (f) =>
          `flag ${f.name} {\n  type ${f.type}\n  fallback ${serializeFallback(f.fallback)}\n}`,
      )
      .join('\n\n') + '\n'
  );
}

function serializeFallback(value: boolean | string | number): string {
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}

connection.onDocumentFormatting((params: DocumentFormattingParams): TextEdit[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const source = doc.getText();
  const formatted = formatVf(source);
  if (formatted === source) return [];

  const lines = source.split('\n');
  const lastLine = lines[lines.length - 1] ?? '';

  return [
    {
      range: Range.create(0, 0, lines.length - 1, lastLine.length),
      newText: formatted,
    },
  ];
});

// ─── Start ────────────────────────────────────────────────────────────────────

documents.listen(connection);
connection.listen();
