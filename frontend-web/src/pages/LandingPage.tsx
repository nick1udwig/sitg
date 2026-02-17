import { Link } from 'react-router-dom';

export function LandingPage() {
  return (
    <section className="landing">
      <div className="landing-brand">Skin In The Game</div>
      <p className="landing-subtitle">Skin In The Game</p>
      <p className="landing-desc">
        Gate pull requests with on-chain stake verification.
        Repository owners configure thresholds; contributors prove their stake to unlock merges.
      </p>
      <div className="landing-cards">
        <Link className="landing-card" to="/owner">
          <div className="landing-card-title">Repository Owner</div>
          <p>Configure stake thresholds, manage whitelists, and set up the GitHub bot for your repositories.</p>
          <span className="landing-card-arrow">&rarr; owner dashboard</span>
        </Link>
        <Link className="landing-card" to="/contributor">
          <div className="landing-card-title">Contributor</div>
          <p>Link your wallet to your GitHub account and manage your stake verification for pull requests.</p>
          <span className="landing-card-arrow">&rarr; contributor portal</span>
        </Link>
      </div>
    </section>
  );
}
