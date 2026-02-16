import { Navigate, Route, Routes } from 'react-router-dom';
import { DesktopOnly } from './components/DesktopOnly';
import { LandingLayout } from './components/LandingLayout';
import { OwnerLayout } from './components/OwnerLayout';
import { ContributorLayout } from './components/ContributorLayout';
import { LandingPage } from './pages/LandingPage';
import { OwnerPage } from './pages/OwnerPage';
import { ContributorPage } from './pages/ContributorPage';
import { GatePage } from './pages/GatePage';

export function App() {
  return (
    <DesktopOnly>
      <Routes>
        <Route element={<LandingLayout />}>
          <Route path="/" element={<LandingPage />} />
        </Route>
        <Route element={<OwnerLayout />}>
          <Route path="/owner" element={<OwnerPage />} />
        </Route>
        <Route element={<ContributorLayout />}>
          <Route path="/contributor" element={<ContributorPage />} />
          <Route path="/g/:gateToken" element={<GatePage />} />
        </Route>
        <Route path="/wallet" element={<Navigate to="/contributor" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </DesktopOnly>
  );
}
