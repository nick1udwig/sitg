import type { ReactNode } from 'react';

export function DesktopOnly({ children }: { children: ReactNode }) {
  const isDesktop = window.matchMedia('(min-width: 900px)').matches;
  if (isDesktop) {
    return <>{children}</>;
  }

  return (
    <section className="card desktop-block">
      <h2>Desktop Only</h2>
      <p className="meta">Stake-to-Contribute MVP supports desktop web only.</p>
      <p>Open this page on a desktop browser to continue.</p>
    </section>
  );
}
