import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppStateProvider, useAppState } from './state';

function Harness() {
  const { state, setRepo, pushNotice, dismissNotice } = useAppState();

  return (
    <div>
      <button onClick={() => setRepo({ id: '1', fullName: 'org/repo' })}>set repo</button>
      <button onClick={() => pushNotice('success', 'ok')}>notice</button>
      <button onClick={() => dismissNotice(0)}>dismiss</button>
      <p data-testid="repo">{state.selectedRepo?.fullName ?? 'none'}</p>
      <p data-testid="notice-count">{state.notices.length}</p>
    </div>
  );
}

describe('AppStateProvider', () => {
  it('stores repo and notices', async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider>
        <Harness />
      </AppStateProvider>
    );

    await user.click(screen.getByText('set repo'));
    expect(screen.getByTestId('repo').textContent).toBe('org/repo');

    await user.click(screen.getByText('notice'));
    expect(screen.getByTestId('notice-count').textContent).toBe('1');

    await user.click(screen.getByText('dismiss'));
    expect(screen.getByTestId('notice-count').textContent).toBe('0');
  });
});
