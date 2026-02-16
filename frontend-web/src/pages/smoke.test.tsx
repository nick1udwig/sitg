import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppStateProvider } from '../state';
import { OwnerPage } from './OwnerPage';

describe('page smoke', () => {
  it('renders owner page pre-auth', () => {
    render(
      <AppStateProvider>
        <OwnerPage />
      </AppStateProvider>
    );

    expect(screen.getByText('Sign in with GitHub')).toBeTruthy();
  });
});
