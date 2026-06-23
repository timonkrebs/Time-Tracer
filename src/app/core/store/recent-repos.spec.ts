import { RecentRepo, RecentRepos } from './recent-repos';

const STORAGE_KEY = 'time-tracer.recent-repos';

function repo(partial: Partial<RecentRepo> & Pick<RecentRepo, 'owner' | 'repo'>): RecentRepo {
  return { description: null, ...partial };
}

describe('RecentRepos', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('records newest first and caps at six entries', () => {
    const recents = new RecentRepos();
    for (let i = 0; i < 8; i++) recents.record(repo({ owner: 'o', repo: `r${i}` }));

    const entries = recents.entries();
    expect(entries).toHaveLength(6);
    expect(entries[0].repo).toBe('r7'); // newest first
    expect(entries.at(-1)?.repo).toBe('r2'); // the two oldest fell off
  });

  it('deduplicates the same repo case-insensitively and moves it to the front', () => {
    const recents = new RecentRepos();
    recents.record(repo({ owner: 'Alice', repo: 'App' }));
    recents.record(repo({ owner: 'bob', repo: 'lib' }));
    recents.record(repo({ owner: 'alice', repo: 'app', description: 'updated' }));

    const entries = recents.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ owner: 'alice', repo: 'app', description: 'updated' });
  });

  it('treats different providers and hosts as distinct repos', () => {
    const recents = new RecentRepos();
    recents.record(repo({ owner: 'o', repo: 'r', provider: 'github' }));
    recents.record(repo({ owner: 'o', repo: 'r', provider: 'gitlab' }));
    recents.record(repo({ owner: 'o', repo: 'r', provider: 'github', host: 'https://ghe.example.com' }));

    expect(recents.entries()).toHaveLength(3);
  });

  it('removes an entry', () => {
    const recents = new RecentRepos();
    recents.record(repo({ owner: 'o', repo: 'keep' }));
    recents.record(repo({ owner: 'o', repo: 'drop' }));

    recents.remove(repo({ owner: 'o', repo: 'drop' }));

    expect(recents.entries().map((e) => e.repo)).toEqual(['keep']);
  });

  it('persists across instances', () => {
    new RecentRepos().record(repo({ owner: 'o', repo: 'r' }));

    expect(new RecentRepos().entries().map((e) => e.repo)).toEqual(['r']);
  });

  it('ignores malformed stored data', () => {
    localStorage.setItem(STORAGE_KEY, 'not json');

    expect(new RecentRepos().entries()).toEqual([]);
  });

  it('drops entries missing required fields when loading', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ owner: 'o', repo: 'r', description: null }, { owner: 'o' }, 42]),
    );

    const entries = new RecentRepos().entries();
    expect(entries).toHaveLength(1);
    expect(entries[0].repo).toBe('r');
  });
});
