import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { DesktopOnly } from './components/DesktopOnly';
import { LandingLayout } from './components/LandingLayout';
import { LandingPage } from './pages/LandingPage';

const OwnerLayout = lazy(() =>
  import('./components/OwnerLayout').then((module) => ({ default: module.OwnerLayout }))
);
const OwnerPage = lazy(() =>
  import('./pages/OwnerPage').then((module) => ({ default: module.OwnerPage }))
);
const ContributorRouteLayout = lazy(() =>
  import('./components/ContributorRouteLayout').then((module) => ({
    default: module.ContributorRouteLayout
  }))
);
const ContributorPage = lazy(() =>
  import('./pages/ContributorPage').then((module) => ({ default: module.ContributorPage }))
);
const GatePage = lazy(() =>
  import('./pages/GatePage').then((module) => ({ default: module.GatePage }))
);

export function App() {
  return (
    <DesktopOnly>
      <Suspense fallback={<main className="route-loading" role="status">Loading...</main>}>
        <Routes>
          <Route element={<LandingLayout />}>
            <Route path="/" element={<LandingPage />} />
          </Route>
          <Route element={<OwnerLayout />}>
            <Route path="/owner" element={<OwnerPage />} />
          </Route>
          <Route element={<ContributorRouteLayout />}>
            <Route path="/contributor" element={<ContributorPage />} />
            <Route path="/g/:gateToken" element={<GatePage />} />
          </Route>
          <Route path="/wallet" element={<Navigate to="/contributor" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </DesktopOnly>
  );
}
