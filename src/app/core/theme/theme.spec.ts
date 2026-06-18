import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { ThemeService } from './theme';

describe('ThemeService', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });

  function service(): ThemeService {
    return TestBed.inject(ThemeService);
  }

  it('defaults to the auto preference', () => {
    expect(service().preference()).toBe('auto');
  });

  it('resolves explicit light and dark preferences directly', () => {
    const theme = service();
    theme.setPreference('light');
    expect(theme.resolved()).toBe('light');
    theme.setPreference('dark');
    expect(theme.resolved()).toBe('dark');
  });

  it('always resolves auto to a concrete theme', () => {
    expect(['light', 'dark']).toContain(service().resolved());
  });

  it('persists the preference and restores it for a fresh instance', () => {
    service().setPreference('light');
    expect(localStorage.getItem('time-tracer.theme')).toBe('light');

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    expect(TestBed.inject(ThemeService).preference()).toBe('light');
  });

  it('cycles auto → light → dark → auto', () => {
    const theme = service();
    expect(theme.preference()).toBe('auto');
    theme.cycle();
    expect(theme.preference()).toBe('light');
    theme.cycle();
    expect(theme.preference()).toBe('dark');
    theme.cycle();
    expect(theme.preference()).toBe('auto');
  });
});
