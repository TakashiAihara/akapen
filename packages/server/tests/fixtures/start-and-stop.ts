/**
 * Start a server in this process and stop it (#238). Run as a child by server.test.ts:
 * the process ending on its own is the evidence that `stop()` released everything that
 * holds the event loop open — the socket, the SSE heartbeat and the file watcher.
 */
import { startServer } from '../../src/server.ts';

const [file] = process.argv.slice(2);
const { stop } = await startServer({
  file: file!,
  host: '127.0.0.1',
  port: 0,
  author: 'test',
  token: null,
  tokenPinned: false,
});
await stop();
console.log('stopped');
