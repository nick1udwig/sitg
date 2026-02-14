import type { ReactNode } from 'react';

export function DesktopOnly({ children }: { children: ReactNode }) {
  const isDesktop = window.matchMedia('(min-width: 900px)').matches;
  if (isDesktop) {
    return <>{children}</>;
  }

  return (
    <section className="card desktop-block">
      <div className="brand">sitg</div>
      <h2>Desktop Only</h2>
      <p className="meta">This tool is designed for desktop browsers.</p>
      <p>Open this page on a desktop browser to continue.</p>
    </section>
  );
}
