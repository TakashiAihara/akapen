/**
 * The documents a long-lived `akapen serve` hands out (#305).
 *
 * One file, written only by the server: the CLI registers and unregisters through the
 * server's API, so there is a single writer and no lock. docs/design/multi-document-server.md
 * has the decisions behind it.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { akapenHome, storeDir, writeAtomic } from './store.ts';

export type DocumentEntry = {
  /** The URL segment: `/d/<id>/`. The store directory's name, so it follows from the path. */
  id: string;
  /** Resolved, as the store keys it. */
  file: string;
  /** The Claude Code session that registered it, when there was one. */
  session?: string;
  /** Where images beside the document may be served from. Absent: the document's directory. */
  root?: string;
  addedAt: string;
};

export function documentsPath(): string {
  return join(akapenHome(), 'documents.json');
}

/** The same value as the store directory's name, so a document's URL and its comments move together. */
export function documentId(file: string): string {
  return basename(storeDir(resolve(file)));
}

const isEntry = (v: unknown): v is DocumentEntry => {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as DocumentEntry;
  return (
    typeof e.id === 'string' &&
    typeof e.file === 'string' &&
    typeof e.addedAt === 'string' &&
    (e.session === undefined || typeof e.session === 'string') &&
    (e.root === undefined || typeof e.root === 'string')
  );
};

/**
 * What is registered. A missing file is none. A file that cannot be parsed throws: read
 * as empty, the next write would replace every registration with what came after it.
 */
export function readDocuments(): DocumentEntry[] {
  let raw: string;
  try {
    raw = readFileSync(documentsPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const parsed = JSON.parse(raw) as { documents?: unknown };
  if (!Array.isArray(parsed.documents)) throw new Error(`${documentsPath()}: no documents array`);
  // Refused rather than skipped: a row left out here is gone after the next write.
  const bad = parsed.documents.findIndex((e) => !isEntry(e));
  if (bad !== -1) throw new Error(`${documentsPath()}: entry ${bad} is not a registration; fix or remove it`);
  return parsed.documents as DocumentEntry[];
}

export function writeDocuments(entries: DocumentEntry[]): void {
  mkdirSync(akapenHome(), { recursive: true });
  writeAtomic(documentsPath(), `${JSON.stringify({ version: 1, documents: entries }, null, 2)}\n`);
}

/**
 * Where the running `akapen serve` listens, so a second one on the same home can find it
 * and refuse to start: two would each write `documents.json` from their own copy.
 */
export function servePath(): string {
  return join(akapenHome(), 'serve.json');
}

export function readServePort(): number | null {
  try {
    const port = (JSON.parse(readFileSync(servePath(), 'utf8')) as { port?: unknown }).port;
    return typeof port === 'number' && Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}

export function writeServePort(port: number): void {
  mkdirSync(akapenHome(), { recursive: true });
  writeAtomic(servePath(), `${JSON.stringify({ port, pid: process.pid })}\n`);
}
