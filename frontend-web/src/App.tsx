import { Navigate, Route, Routes } from 'react-router-dom';
import { DesktopOnly } from './components/DesktopOnly';
import { Layout } from './components/Layout';
import { GatePage } from './pages/GatePage';
import { OwnerSetupPage } from './pages/OwnerSetupPage';
import { WalletPage } from './pages/WalletPage';

export function App() {
  return (
    <DesktopOnly>
      <Layout>
        <Routes>
          <Route path="/" element={<OwnerSetupPage />} />
          <Route path="/wallet" element={<WalletPage />} />
          <Route path="/g/:gateToken" element={<GatePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </DesktopOnly>
  );
}
