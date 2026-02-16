import { Outlet } from 'react-router-dom';
import { Notices } from './Notices';

export function LandingLayout() {
  return (
    <>
      <Notices />
      <Outlet />
    </>
  );
}
