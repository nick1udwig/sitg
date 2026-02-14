import { Link, useLocation } from 'react-router-dom';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import type { ReactNode } from 'react';
import { useAppState } from '../state';
import { Notices } from './Notices';

export function Layout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { state } = useAppState();

  return (
    <>
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand">sitg</div>
          <nav className="nav" aria-label="Primary">
            <Link className={location.pathname === '/' ? 'active' : ''} to="/">
              Setup
            </Link>
            <Link className={location.pathname.startsWith('/wallet') ? 'active' : ''} to="/wallet">
              Wallet
            </Link>
          </nav>
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
      {children}
    </>
  );
}
