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
        <div className="brand">SITG</div>
        <nav className="nav" aria-label="Primary">
          <Link className={location.pathname === '/' ? 'active' : ''} to="/">
            Owner Setup
          </Link>
          <Link className={location.pathname.startsWith('/wallet') ? 'active' : ''} to="/wallet">
            Wallet
          </Link>
        </nav>
        <div className="topbar-right">
          {state.me ? <span className="badge">@{state.me.github_login}</span> : <span className="badge warn">Signed out</span>}
          <ConnectButton chainStatus="icon" showBalance={false} accountStatus="address" />
        </div>
      </header>
      <Notices />
      {children}
    </>
  );
}
