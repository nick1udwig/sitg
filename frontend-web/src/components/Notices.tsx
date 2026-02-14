import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppState } from '../state';

export function Notices() {
  const { state, dismissNotice } = useAppState();
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const dismissingRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    for (const notice of state.notices) {
      if (!timersRef.current.has(notice.id) && !dismissingRef.current.has(notice.id)) {
        const timer = setTimeout(() => {
          handleDismiss(notice.id);
        }, 5000);
        timersRef.current.set(notice.id, timer);
      }
    }

    const activeIds = new Set(state.notices.map((n) => n.id));
    for (const [id, timer] of timersRef.current) {
      if (!activeIds.has(id)) {
        clearTimeout(timer);
        timersRef.current.delete(id);
        dismissingRef.current.delete(id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.notices]);

  function handleDismiss(id: number) {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    dismissingRef.current.add(id);

    // Brief delay for slide-out animation
    setTimeout(() => {
      dismissNotice(id);
      dismissingRef.current.delete(id);
    }, 200);
  }

  if (!state.notices.length) {
    return null;
  }

  return createPortal(
    <div className="toast-container" aria-live="polite">
      {state.notices.map((notice) => {
        const isDismissing = dismissingRef.current.has(notice.id);

        return (
          <div
            key={notice.id}
            className={`toast toast-border-${notice.type}${isDismissing ? ' dismissing' : ''}`}
          >
            <div className="toast-body">
              <div className={`toast-type ${notice.type}`}>{notice.type}</div>
              <p className="toast-message">{notice.message}</p>
            </div>
            <button className="toast-close" onClick={() => handleDismiss(notice.id)} aria-label="Dismiss">
              {'\u00d7'}
            </button>
            {!isDismissing && <div className="toast-progress" />}
          </div>
        );
      })}
    </div>,
    document.body
  );
}
