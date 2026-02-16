import { Outlet } from 'react-router-dom';
import { logout } from '../api';
import { useAppState } from '../state';
import { Notices } from './Notices';

export function OwnerLayout() {
  const { state, runBusy, isBusy } = useAppState();

  const handleLogout = async (): Promise<void> => {
    const ok = await runBusy('logout', async () => {
      await logout();
      return true;
    });
    if (ok) window.location.href = '/';
  };

  return (
    <div className="owner-layout">
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand">sitg</div>
          <span className="nav-context">owner</span>
        </div>
        <div className="topbar-right">
          {state.me ? (
            <>
              <span className="auth-badge">
                <span className="auth-dot" />
                @{state.me.github_login}
              </span>
              <button className="ghost topbar-signout" disabled={isBusy('logout')} onClick={() => void handleLogout()}>
                {isBusy('logout') ? 'Signing out...' : 'Sign out'}
              </button>
            </>
          ) : (
            <span className="auth-badge">
              <span className="auth-dot offline" />
              signed out
            </span>
          )}
        </div>
      </header>
      <div className="owner-layout-content">
        <Notices />
        <Outlet />
      </div>
    </div>
  );
}
