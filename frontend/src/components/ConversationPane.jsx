import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { useStore } from '../store/index.js';
import {
  normalizeConversation,
  initialExpandedMessageIds,
  conversationMembershipKey,
  newestConversationMessage,
} from '../utils/conversation.js';
import { archiveThread, deleteThread, spamThread, moveThread, snoozeThread, inAccount } from '../utils/threadActions.js';
import { buildPrintDocument, openPrintWindow, printInWindow } from '../utils/printMessage.js';
import ConversationMessageCard from './ConversationMessageCard.jsx';
import ContextMenu from './ContextMenu.jsx';

function ThreadBtn({ onClick, title, children }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px',
        background: 'none', border: '1px solid var(--border)', borderRadius: 4,
        color: 'var(--text-primary)', font: 'inherit', fontSize: 13, cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

// The whole conversation, stacked, with only what the reader has opened rendered.
//
// The thread endpoint already returns every message across folders, Sent replies included,
// deduplicated by Message-ID preferring the INBOX copy, so showing it needs no scope parameter
// of its own. It also holds another account's copy of the same email (#476), which stays on
// screen. accountId, the account whose copies the actions take (ReadingPane says which), keeps
// the actions and the card that opens to that account's copies; null keeps every copy.
//
// Design from #317 by YunQue0912.
export default function ConversationPane({ threadId, folder, unified = false, accountId = null, selectedMessageId = null }) {
  const { t } = useTranslation();
  const addNotification = useStore(s => s.addNotification);
  const accounts = useStore(s => s.accounts);
  const setSelectedMessage = useStore(s => s.setSelectedMessage);
  const updateMessage = useStore(s => s.updateMessage);
  const [messages, setMessages] = useState([]);
  const [expanded, setExpanded] = useState(() => new Set());
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  // { x, y, view, message } — the move and snooze pickers are ContextMenu's, opened straight
  // into the relevant sub-view rather than reimplemented here. message is the copy they open on.
  const [picker, setPicker] = useState(null);
  const [aiStatus, setAiStatus] = useState(null);

  useEffect(() => {
    api.ai.status().then(setAiStatus).catch(() => {});
  }, []);
  const aiEnabled = Boolean(aiStatus?.enabled && aiStatus?.features?.summarize);

  // Read when the conversation arrives, without making the pick a reason to fetch it again.
  const pickedRef = useRef(selectedMessageId);
  pickedRef.current = selectedMessageId;

  useEffect(() => {
    if (!threadId) { setMessages([]); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.getThread(threadId, folder, unified)
      .then(data => {
        if (cancelled) return;
        const ordered = normalizeConversation(data?.messages || []);
        setMessages(ordered);
        // A picker opened on the previous conversation's cards while this one loaded (below).
        setPicker(null);
        // Opens on the newest message, the way every threaded client does: the reader
        // almost always wants the latest reply, and expanding everything would render a
        // document per message. The newest of accountId's copies, since opening a card marks it
        // read. When the reader picked the other account's copy under the row, that copy opens on
        // its own (the effect below): opening the row's copy beside it would mark that read too,
        // behind a list row whose unread count does not follow.
        const picked = ordered.find(message => message.id === pickedRef.current);
        setExpanded(accountId && picked && picked.account_id !== accountId
          ? new Set()
          : initialExpandedMessageIds(inAccount(ordered, accountId)));
      })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [threadId, folder, unified, accountId]);

  // The pane stays mounted from one conversation to the next, so an open picker would
  // otherwise apply its pick to a conversation it was not opened on. The previous
  // conversation's cards and buttons stay on screen until the next one lands, so a picker can
  // still be opened on them after this runs; the fetch above closes that one when it lands.
  useEffect(() => { setPicker(null); }, [threadId, accountId]);

  // Opening a message from the list opens it here too. Picking a different message in the
  // same thread leaves threadId untouched, so the pane used to re-render with identical
  // props and nothing happened on screen, which read as the click being ignored.
  const stackRef = useRef(null);
  useEffect(() => {
    if (!selectedMessageId || !messages.some(message => message.id === selectedMessageId)) return;
    setExpanded(prev => (prev.has(selectedMessageId) ? prev : new Set(prev).add(selectedMessageId)));
    // Long threads run past the fold, so the message that was asked for is brought into
    // view rather than being opened somewhere off screen.
    const card = stackRef.current?.querySelector(`[data-message-id="${selectedMessageId}"]`);
    card?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedMessageId, messages]);

  const toggle = (id) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // A link can open a message whose account the thread route leaves out (a disabled one), so the
  // pane can hold none of that account's copies. Every action would then take nothing, and
  // closing the pane as if one had worked is the silent failure this guard exists to avoid.
  const holdsNoCopyToActOn = () => {
    if (inAccount(messages, accountId).length) return false;
    console.warn(`Conversation ${threadId} holds no copy of account ${accountId}; nothing to act on`);
    return true;
  };

  // Acting on the conversation empties the reading pane: every message it was showing
  // has just been removed from the list behind it.
  const runAction = (action) => {
    if (holdsNoCopyToActOn()) return;
    const scheduled = action(messages, {
      t,
      addNotification,
      accounts,
      accountId,
      // The authoritative list, re-read when the action actually commits, so a reply
      // that arrived while this conversation was open is not left behind.
      fetchThread: () => api.getThread(threadId, folder, unified),
    });
    // The copies on screen can still leave an action nothing to take: Snooze takes only an INBOX
    // copy, and Spam only mail the reader did not send. The pane stays then too, as above.
    if (!scheduled) {
      console.warn(`Conversation ${threadId} holds nothing this action applies to${accountId ? ` in account ${accountId}` : ''}; nothing to act on`);
      return;
    }
    setSelectedMessage(null);
  };

  // A flag change on one card: the pane's copy of the thread and the list's copy both change.
  const updateConversationMessage = (id, patch) => {
    setMessages(prev => prev.map(message => (message.id === id ? { ...message, ...patch } : message)));
    updateMessage(id, patch);
  };

  // The window opens on the click, before any await, or the browser blocks it. Bodies are loaded
  // one at a time: collapsed messages have none yet, and a session-limited provider serves the
  // account over a single connection.
  const printConversation = async () => {
    const win = openPrintWindow(t('message.preparingPrint'));
    if (!win) return;
    const entries = [];
    for (const message of messages) {
      const body = await api.getMessageBody(message.id).catch(() => null);
      if (win.closed) return;
      entries.push({ message, body });
    }
    printInWindow(win, buildPrintDocument(entries));
  };

  // Both pickers open on the newest of accountId's copies (of any account's in the unified inbox):
  // the move picker lists that copy's account's folders, and the snooze picker's Back row leads
  // to the full menu, whose plugin items (GTD classify) act on that copy.
  const openPicker = (event, view) => {
    if (holdsNoCopyToActOn()) return;
    const pickerMessage = newestConversationMessage(inAccount(messages, accountId));
    const rect = event.currentTarget.getBoundingClientRect();
    setPicker({ x: rect.left, y: rect.bottom + 4, view, message: pickerMessage });
  };

  // Every branch that returns from here fills the reading area, for the same flex reason
  // as the stack below: a bare div would collapse to the width of its own text.
  const fill = { flex: 1, minWidth: 0, height: '100%', background: 'var(--bg-primary)' };

  if (error) return <div style={{ ...fill, padding: 16, color: 'var(--red, #e03131)' }}>{error}</div>;
  if (loading && !messages.length) {
    return (
      <div style={{ ...fill, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="skeleton-line" style={{ height: 13, width: '48%', borderRadius: 4 }} />
        <div className="skeleton-line" style={{ height: 13, width: '70%', borderRadius: 4 }} />
      </div>
    );
  }
  if (!messages.length) return null;

  return (
    <div
      // Remounts the stack when the thread's membership changes, so expansion state from a
      // previous conversation can never be applied to this one's message ids.
      key={conversationMembershipKey(messages)}
      ref={stackRef}
      // flex: 1 and minWidth: 0 are load-bearing. The reading area is a flex row, so
      // without them this pane is sized shrink-to-fit by its contents: collapsed cards
      // are narrow, an expanded newsletter is as wide as the newsletter, and the pane
      // jumped around as the reader opened and closed messages. minWidth: 0 is the other
      // half, since a flex item defaults to min-width:auto and a wide email would
      // otherwise push the pane past its share of the row.
      style={{
        flex: 1, minWidth: 0,
        padding: 12, overflowY: 'auto', height: '100%',
        background: 'var(--bg-primary)',
      }}
    >
      {/* Thread-level actions, the way Gmail does it: archiving a conversation archives
          all of it, so the reader does not file the same thread message by message. */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <ThreadBtn onClick={() => runAction(archiveThread)} title={t('message.archive')}>
          {t('message.archive')}
        </ThreadBtn>
        <ThreadBtn onClick={() => runAction(deleteThread)} title={t('message.delete')}>
          {t('message.delete')}
        </ThreadBtn>
        <ThreadBtn onClick={() => runAction(spamThread)} title={t('contextMenu.markAsSpam')}>
          {t('contextMenu.markAsSpam')}
        </ThreadBtn>
        <ThreadBtn
          onClick={e => openPicker(e, 'move')}
          title={t('contextMenu.moveToFolder')}
        >
          {t('contextMenu.moveToFolder')}
        </ThreadBtn>
        <ThreadBtn
          onClick={e => openPicker(e, 'snooze')}
          title={t('contextMenu.snooze.label')}
        >
          {t('contextMenu.snooze.label')}
        </ThreadBtn>
        <ThreadBtn onClick={printConversation} title={t('message.printConversation')}>
          {t('message.printConversation')}
        </ThreadBtn>
      </div>

      {picker && (
        <ContextMenu
          x={picker.x}
          y={picker.y}
          message={picker.message}
          variant="conversation"
          defaultMoveView={picker.view === 'move'}
          defaultSnoozeView={picker.view === 'snooze'}
          onClose={() => setPicker(null)}
          onAction={(action, data) => {
            if (action === 'moveTo') runAction((list, opts) => moveThread(list, data, opts));
            else if (action === 'snooze') runAction((list, opts) => snoozeThread(list, data, opts));
            setPicker(null);
          }}
        />
      )}

      {messages.map(message => (
        <ConversationMessageCard
          key={message.id}
          message={message}
          expanded={expanded.has(message.id)}
          selected={message.id === selectedMessageId}
          onToggle={toggle}
          onUpdate={updateConversationMessage}
          aiEnabled={aiEnabled}
        />
      ))}
    </div>
  );
}
