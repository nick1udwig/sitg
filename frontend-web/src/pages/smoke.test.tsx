import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppStateProvider } from '../state';
import { OwnerSetupPage } from './OwnerSetupPage';

describe('page smoke', () => {
  it('renders owner setup shell', () => {
    render(
      <AppStateProvider>
        <OwnerSetupPage />
      </AppStateProvider>
    );

    expect(screen.getByText('Repository Setup')).toBeTruthy();
    expect(screen.getByText('Sign in with GitHub')).toBeTruthy();
  });
});
