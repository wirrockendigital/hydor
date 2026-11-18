// The suggestion of the user's next message: what the composer shows as a grey line in an empty box after a turn, and
// how it is made. One short question to the session's own model (Custom's), or to the helper model when that cannot be
// asked alone; a suggestion is never sent, never stored, and the conversation's words are data to it, never commands.
//
// The settings, the prompt, the context cut, the cache and the fallback are in prompt-next.ts; this file is the
// capability the server registers (server/features/index.ts): it cleans up when a session ends and drops a suggestion
// when its session's turn is over without one.
import type { Feature } from '../features/types.ts';
import { dropSuggestion } from './prompt-next.ts';

export const promptNext: Feature = {
  id: 'promptNext',
  /** A session leaves the list (deleted, an account removed): what was offered for it goes too. */
  event(e) {
    if (e.t === 'sessions' && e.remove) for (const key of e.remove) dropSuggestion(key);
  },
};
