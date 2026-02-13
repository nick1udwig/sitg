import { describe, expect, it } from 'vitest';
import { addErrorNotice, clearNotices, getState, withBusyAction } from './state';

describe('state', () => {
  it('tracks busy action and returns result', async () => {
    clearNotices();
    const result = await withBusyAction('k', async () => 42);
    expect(result).toBe(42);
    expect(getState().busy.k).toBe(false);
  });

  it('captures action failures as notices', async () => {
    clearNotices();
    const result = await withBusyAction('f', async () => {
      throw new Error('boom');
    });

    expect(result).toBeNull();
    expect(getState().notices[0].message).toBe('boom');
  });

  it('retains at most three notices', () => {
    clearNotices();
    addErrorNotice('1');
    addErrorNotice('2');
    addErrorNotice('3');
    addErrorNotice('4');

    expect(getState().notices).toHaveLength(3);
    expect(getState().notices[0].message).toBe('4');
  });
});
