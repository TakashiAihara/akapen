/**
 * Start `akapen serve` in this process, open a document, and stop it (#238). Run as a child
 * by server.test.ts: the process ending on its own is the evidence that `stop()` released
 * everything that holds the event loop open — the socket, the heartbeats and the file
 * watcher of the document that was opened.
 */
import { documentId, writeDocuments } from '@akapen/core/documents';
import { startDaemon } from '../../src/server.ts';

const [file] = process.argv.slice(2);
writeDocuments([{ id: documentId(file!), file: file!, addedAt: new Date().toISOString() }]);
const { server, stop } = startDaemon({
  host: '127.0.0.1',
  port: 0,
  author: 'test',
  token: null,
  tokenPinned: false,
  manageToken: 'unused',
});
// A document is opened by its first request, and its watcher is what has to be released.
const opened = await fetch(
  `http://127.0.0.1:${server.port}/d/${encodeURIComponent(documentId(file!))}/api/status`,
);
if (!opened.ok) throw new Error(`the document did not open: ${opened.status}`);
await stop();
console.log('stopped');
