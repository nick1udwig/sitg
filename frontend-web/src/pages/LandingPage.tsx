import { Link } from 'react-router-dom';

export function LandingPage() {
  return (
    <section className="landing">
      <div className="landing-brand">Skin In The Game</div>
      <p className="landing-desc">
        Gate pull requests with 30-day bonds.
        Repo owner configures thresholds; contributors place temporary bond to prove commitment.
      </p>
      <div className="landing-cards">
        <Link className="landing-card" to="/owner">
          <div className="landing-card-title">Repository Owner</div>
          <p>Configure stake thresholds and manage whitelists.</p>
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
