import { disambiguateLabels } from './path-label';

describe('disambiguateLabels', () => {
  it('uses the basename when it is unique', () => {
    const labels = disambiguateLabels(['src/auth.ts', 'src/session.ts', 'README.md']);
    expect(labels.get('src/auth.ts')).toBe('auth.ts');
    expect(labels.get('src/session.ts')).toBe('session.ts');
    expect(labels.get('README.md')).toBe('README.md');
  });

  it('falls back to the full path when basenames collide', () => {
    const labels = disambiguateLabels(['src/auth/index.ts', 'src/api/index.ts', 'src/main.ts']);
    // Two index.ts → show the full path; the unique one stays a basename.
    expect(labels.get('src/auth/index.ts')).toBe('src/auth/index.ts');
    expect(labels.get('src/api/index.ts')).toBe('src/api/index.ts');
    expect(labels.get('src/main.ts')).toBe('main.ts');
  });

  it('handles an empty set', () => {
    expect(disambiguateLabels([]).size).toBe(0);
  });
});
