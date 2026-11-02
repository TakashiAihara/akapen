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

  await expect(startPeer(akapen.home, 'mine.md', [], taken)).rejects.toThrow(
    /exited before serving .*mine\.md/,
  );
});
