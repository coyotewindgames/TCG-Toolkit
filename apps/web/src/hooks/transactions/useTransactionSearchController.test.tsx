/* @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useTransactionSearchController } from './useTransactionSearchController';

describe('useTransactionSearchController', () => {
  it('debounces query updates and enables search at min length', () => {
    vi.useFakeTimers();

    const { result } = renderHook(() =>
      useTransactionSearchController({ debounceMs: 200, minQueryLength: 2 }),
    );

    act(() => {
      result.current.setQuery('a');
    });

    expect(result.current.query).toBe('a');
    expect(result.current.normalizedQuery).toBe('');
    expect(result.current.isSearchEnabled).toBe(false);

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.normalizedQuery).toBe('a');
    expect(result.current.isSearchEnabled).toBe(false);

    act(() => {
      result.current.setQuery('  ab  ');
    });

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.normalizedQuery).toBe('ab');
    expect(result.current.isSearchEnabled).toBe(true);

    vi.useRealTimers();
  });

  it('supports empty-query search when allowEmpty is true', () => {
    vi.useFakeTimers();

    const { result } = renderHook(() =>
      useTransactionSearchController({ allowEmpty: true, minQueryLength: 2, debounceMs: 100 }),
    );

    expect(result.current.isSearchEnabled).toBe(true);

    act(() => {
      result.current.setQuery('x');
    });

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current.normalizedQuery).toBe('x');
    expect(result.current.isSearchEnabled).toBe(false);

    act(() => {
      result.current.setQuery('');
    });

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current.normalizedQuery).toBe('');
    expect(result.current.isSearchEnabled).toBe(true);

    vi.useRealTimers();
  });
});
