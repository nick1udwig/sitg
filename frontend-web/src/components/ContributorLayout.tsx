import { Outlet } from 'react-router-dom';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAppState } from '../state';
import { Notices } from './Notices';

export function ContributorLayout() {
  const { state } = useAppState();

  return (
    <>
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand">Skin In The Game</div>
          <span className="nav-context">contributor</span>
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
          <ConnectButton chainStatus="icon" showBalance={false} accountStatus="address" />
        </div>
      </header>
      <Notices />
      <Outlet />
    </>
  );
}
