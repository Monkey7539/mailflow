import { useStore } from '../store/index.js';
import { api } from './api.js';
import { normalizeConversation, newestConversationMessage } from './conversation.js';
import { conversationActionIds, conversationSpamTargets, newestSnoozeTarget } from './conversationActions.js';
import { setPendingDelete, setCompletedDelete, clearDeleteGuard, clearPendingDelete } from './pendingDeletes.js';
import { archiveTargetsForFolder } from './threadedArchive.js';

// Which messages a thread-wide action should actually operate on.
//
// A thread row stands for several messages, so acting on one means resolving the rest. The
// obvious place to get them is the cache populated when the thread was last expanded, and that
// is the trap: the cache is a snapshot, and a thread gains messages while you are looking at it.
//
// The observed failure: a GitHub thread received a reply after the thread was opened. Marking it
// read sent the bulk-read call for the CACHED ids, so the newer message was never included and
// stayed unread on the server. The UI then marked the cached copies read, so the row rendered as
// read with the unread message hidden inside it. The account badge showed 1 unread that could
// not be cleared by any amount of clicking, because the message was unreachable.
//
// The same staleness is worse for the destructive paths. A thread-wide delete or move built from
// a stale list silently leaves the newest messages behind, which is the bug the bulk-delete
// comment in MessageList already describes having fixed once.
//
// So the cache renders; the server decides what to act on. `allowCache` has to be asked for
// explicitly, and nothing currently asks, which is the point: a future caller has to think about
// staleness rather than inherit it by default.

/**
 * @param message      the row the action was invoked on
 * @param isThreadRow  false for an ordinary message row, which is already the whole action
 * @param cached       previously fetched sub-messages, used only when allowCache is true
 * @param fetchThread  () => Promise<{ messages }> — authoritative fetch
 * @param allowCache   opt in to the snapshot; only safe when staleness cannot change the outcome
 */
export async function resolveThreadMessages({ message, isThreadRow, cached, fetchThread, allowCache = false }) {
  if (!isThreadRow) return [message];
  if (allowCache && Array.isArray(cached) && cached.length > 0) return cached;
  const data = await fetchThread();
  // An empty or malformed response must not silently reduce the action to nothing: fall back to
  // the row itself, which is the same conservative choice the previous implementation made.
  return data?.messages?.length ? data.messages : [message];
}

// ---------------------------------------------------------------------------
// Performing a thread-wide action.
//
// Every one of these follows the shape MessagePane established for a single message:
// remove optimistically so the list responds immediately, hold the real request for the
// length of the undo window, and put everything back if the user undoes it or the
// request fails. Acting on a conversation only changes how many messages move together,
// which is why it is one runner and a few thin callers.
//
// The optimistic removal uses the messages the pane is showing, because that is what the
// reader can see. The request does not: at commit time it re-resolves the thread from the
// server, for the staleness reason documented at the top of this file. A reply that landed
// while the conversation was open must be archived along with the rest of it, not left
// behind to resurrect the thread.

const UNDO_WINDOW_MS = 4500;

export function runThreadAction({ messages, commit, resolve, notification, addNotification, onRemove, onRestore }) {
  const targets = normalizeConversation(messages);
  if (!targets.length) return;

  const unread = targets.filter(message => !message.is_read);
  const store = useStore.getState();
  targets.forEach(message => store.removeMessage(message.id));
  unread.forEach(message => store.decrementUnread(message.account_id));
  onRemove?.(targets);

  const restore = () => {
    const state = useStore.getState();
    state.restoreMessages(targets);
    unread.forEach(message => state.incrementUnread(message.account_id));
    onRestore?.(targets);
  };

  let undone = false;
  const timer = setTimeout(async () => {
    if (undone) return;
    try {
      // Resolve last, so a message that arrived during the undo window is included.
      const live = resolve ? normalizeConversation(await resolve(targets)) : targets;
      await commit(live.length ? live : targets);
    } catch (err) {
      console.error('Thread action failed:', err);
      restore();
      addNotification({
        type: 'error',
        title: notification.failTitle,
        body: err.message || notification.failBody,
      });
    }
  }, UNDO_WINDOW_MS);

  addNotification({
    title: notification.title,
    body: notification.body,
    onUndo: () => {
      undone = true;
      clearTimeout(timer);
      restore();
    },
  });
}

const subjectOf = (messages, t) =>
  newestConversationMessage(messages)?.subject || t('common.noSubject');

// fetchThread is the authoritative lookup, supplied by the pane that knows the thread id
// and folder. Omitting it falls back to the messages on screen. `select` applies the same
// choice the action made on screen to what the lookup returns.
const liveThread = (fetchThread, select = messages => messages) => fetchThread
  ? async (targets) => select(await resolveThreadMessages({
      message: targets[0],
      isThreadRow: true,
      fetchThread,
    }))
  : null;

// Archive and delete act on the conversation as the list behind the pane shows it: its
// messages in one folder and, outside the unified inbox, one account (see ReadingPane), which
// is what the list's own thread archive takes (#361). The pane also shows the reader's Sent
// replies and copies filed elsewhere, for context. Archive is a move on IMAP, so including
// those would take a reply out of Sent, and bulk-delete expunges anything already in Trash or
// Drafts rather than moving it there.
const inListScope = ({ row, accountId = null, folder = 'INBOX' }) => messages =>
  archiveTargetsForFolder(row, messages, accountId ? folder : 'INBOX', true, accountId);

export function archiveThread(messages, { t, addNotification, fetchThread, scope }) {
  const inScope = inListScope(scope);
  runThreadAction({
    messages: inScope(messages),
    addNotification,
    resolve: liveThread(fetchThread, inScope),
    commit: async (targets) => {
      const result = await api.bulkArchive(conversationActionIds(targets));
      // Not an error: the account simply has no archive folder mapped, and the user
      // needs telling, because nothing moved.
      if (result?.noArchiveFolder?.length) {
        addNotification({ title: t('message.archived.noFolderTitle'), body: t('message.archived.noFolderBody') });
      }
    },
    notification: {
      title: t('message.archived.conversationTitle'),
      body: subjectOf(messages, t),
      failTitle: t('message.archived.failTitle'),
      failBody: t('message.archived.failBody'),
    },
  });
}

export function deleteThread(messages, { t, addNotification, fetchThread, scope }) {
  const inScope = inListScope(scope);
  runThreadAction({
    messages: inScope(messages),
    addNotification,
    resolve: liveThread(fetchThread, inScope),
    // The delete guards stop a sync already in flight from resurrecting the rows
    // between the optimistic removal and the commit.
    onRemove: targets => targets.forEach(message => setPendingDelete(message.id)),
    onRestore: targets => targets.forEach(message => { clearPendingDelete(message.id); clearDeleteGuard(message.id); }),
    commit: async (targets) => {
      await api.bulkDelete(conversationActionIds(targets));
      targets.forEach(message => setCompletedDelete(message.id));
    },
    notification: {
      title: t('messageList.deleted.conversationTitle'),
      body: t('messageList.deleted.body'),
      failTitle: t('messageList.deleted.failTitle'),
      failBody: t('messageList.deleted.failBody'),
    },
  });
}

// A folder path belongs to one account: the row's, whose folders the picker lists. Only that
// account's copies are sent, as from the list, or the row itself when the thread holds none of
// them. bulk-move skips any other account that has no folder at the path, and still answers ok.
export function moveThread(messages, folder, { t, addNotification, fetchThread, scope }) {
  const accountId = scope.row.account_id;
  const inAccount = (list) => {
    const own = normalizeConversation(list).filter(message => message.account_id === accountId);
    return own.length ? own : [scope.row];
  };
  runThreadAction({
    messages: inAccount(messages),
    addNotification,
    resolve: liveThread(fetchThread, inAccount),
    commit: async (targets) => {
      await api.bulkMove(conversationActionIds(targets), folder);
      useStore.getState().recordRecentFolder({ accountId, path: folder });
    },
    notification: {
      title: t('message.moved.conversationTitle'),
      body: folder,
      failTitle: t('message.moved.failTitle'),
      failBody: t('message.moved.failBody'),
    },
  });
}

// Reporting spam acts on the correspondent's messages only. Sweeping the reader's own
// replies into the spam folder would train the filter on their own address.
export function spamThread(messages, { t, addNotification, accounts = [], fetchThread }) {
  const visible = conversationSpamTargets(messages, accounts);
  const resolveLive = liveThread(fetchThread);
  runThreadAction({
    messages: visible,
    addNotification,
    // Re-apply the same exclusion to whatever the server returns, so a reply sent during
    // the undo window is not reported as spam either.
    resolve: resolveLive ? async (targets) => conversationSpamTargets(await resolveLive(targets), accounts) : null,
    commit: async (list) => { await Promise.all(list.map(message => api.markSpam(message.id))); },
    notification: {
      title: t('spam.conversationMovedToSpam'),
      body: subjectOf(visible, t),
      failTitle: t('spam.failTitle'),
      failBody: t('spam.failBody'),
    },
  });
}

// Snooze takes the newest inbox message rather than the thread: the others are already
// filed or sent, and re-delivering them would duplicate the conversation on return.
export function snoozeThread(messages, until, { t, addNotification }) {
  const target = newestSnoozeTarget(messages);
  if (!target) return;
  runThreadAction({
    messages: [target],
    addNotification,
    commit: async (list) => { await api.snoozeMessage(list[0].id, until); },
    notification: {
      title: t('message.snoozed.conversationTitle'),
      body: subjectOf([target], t),
      failTitle: t('message.snoozed.failTitle'),
      failBody: t('message.snoozed.failBody'),
    },
  });
}
