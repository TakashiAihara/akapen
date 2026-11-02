/**
 * The fixture itself: a server started on a port another akapen already holds (#277).
 *
 * Every run counts ports up from the same number and uses the same token, so a second run
 * on the same host finds the first one's server answering on "its" port. Passing then means
 * every assertion after it was made against somebody else's document.
 */
import { expect, startPeer, test } from './fixtures.ts';

test('a peer whose port is already held by another akapen fails instead of measuring that one', async ({
  akapen,
}) => {
  const taken = Number(new URL(akapen.url).port);

  const started = await startPeer(akapen.home, 'mine.md', [], taken).then(
    (peer) => peer,
    (err: Error) => err,
  );
  // A peer handed back here is the defect. Stopped before failing, because once this test's
  // own server lets go of the port, a peer still booting would take it and outlive the run.
  if (!(started instanceof Error)) await started.stop();

  expect(started).toBeInstanceOf(Error);
  expect((started as Error).message).toMatch(/exited before serving .*mine\.md/);
  // The reason is the port, not any other way of failing to start.
  expect((started as Error).message).toContain(`--port ${taken} is in use`);
});
