import { Outlet } from 'react-router-dom';
import { useAppState } from '../state';
import { Notices } from './Notices';

export function OwnerLayout() {
  const { state } = useAppState();

  return (
    <>
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand">sitg</div>
          <span className="nav-context">owner</span>
        </div>
        <div className="topbar-right">
          {state.me ? (
            <span className="auth-badge">
              <span className="auth-dot" />
              @{state.me.github_login}
            </span>
          ) : (
            <span className="auth-badge">
              <span className="auth-dot offline" />
              signed out
            </span>
          )}
        </div>
      </header>
      <Notices />
      <Outlet />
    </>
  );
}
