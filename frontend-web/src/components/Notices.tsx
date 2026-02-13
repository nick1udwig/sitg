import { useAppState } from '../state';

export function Notices() {
  const { state, dismissNotice } = useAppState();

  if (!state.notices.length) {
    return null;
  }

  return (
    <section className="grid" aria-live="polite">
      {state.notices.map((notice, index) => (
        <article key={`${notice.type}-${index}`} className={`card notice-toast notice-${notice.type}`}>
          <div>
            <p className="meta">{notice.type.toUpperCase()}</p>
            <p>{notice.message}</p>
          </div>
          <button className="ghost" onClick={() => dismissNotice(index)}>
            Dismiss
          </button>
        </article>
      ))}
    </section>
  );
}
