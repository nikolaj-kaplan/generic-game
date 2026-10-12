import { useCallback, useState } from 'react';

interface Pending {
  message: string;
  confirmLabel: string;
  onYes: () => void;
}

/**
 * In-app replacement for window.confirm(). Embedded browsers (in-app WebViews,
 * the Claude preview pane) can block native dialogs, which makes confirm()
 * return false at once, so "Leave" silently did nothing there.
 *
 *   const { ask, dialog } = useConfirm();
 *   ask('Leave this game?', leaveSession, 'Leave');
 *   return <>{dialog}…</>;
 */
export function useConfirm() {
  const [pending, setPending] = useState<Pending | null>(null);

  const ask = useCallback((message: string, onYes: () => void, confirmLabel = 'OK') => {
    setPending({ message, onYes, confirmLabel });
  }, []);

  const dialog = pending ? (
    <div className="confirm-overlay" onClick={() => setPending(null)}>
      <div
        className="confirm-panel"
        role="alertdialog"
        aria-modal="true"
        aria-label={pending.message}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && setPending(null)}
      >
        <p className="confirm-panel__message">{pending.message}</p>
        <div className="confirm-panel__actions">
          <button className="btn btn--secondary" onClick={() => setPending(null)}>
            Cancel
          </button>
          <button
            className="btn btn--danger"
            autoFocus
            onClick={() => {
              const { onYes } = pending;
              setPending(null);
              onYes();
            }}
          >
            {pending.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { ask, dialog };
}
