import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TreeEntry } from '../../core/models';
import { FileFinder } from './file-finder';

const FILES: TreeEntry[] = [
  { path: 'src/app/app.ts', name: 'app.ts', kind: 'file', sha: '1' },
  { path: 'src/app/main.ts', name: 'main.ts', kind: 'file', sha: '2' },
  { path: 'README.md', name: 'README.md', kind: 'file', sha: '3' },
];

describe('FileFinder', () => {
  let fixture: ComponentFixture<FileFinder>;
  let selected: string[];
  let closedCount: number;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FileFinder],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    fixture = TestBed.createComponent(FileFinder);
    fixture.componentRef.setInput('files', FILES);
    selected = [];
    closedCount = 0;
    fixture.componentInstance.fileSelect.subscribe((path) => selected.push(path));
    fixture.componentInstance.closed.subscribe(() => closedCount++);
    await fixture.whenStable();
  });

  function input(): HTMLInputElement {
    return fixture.nativeElement.querySelector('input') as HTMLInputElement;
  }

  async function type(value: string): Promise<void> {
    const el = input();
    el.value = value;
    el.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  }

  function rows(): HTMLButtonElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('li button'));
  }

  async function press(key: string): Promise<void> {
    input().dispatchEvent(new KeyboardEvent('keydown', { key }));
    await fixture.whenStable();
  }

  it('lists every file before a query is typed', () => {
    expect(rows()).toHaveLength(FILES.length);
  });

  it('filters to fuzzy matches as the query is typed', async () => {
    await type('main');
    const labels = rows().map((b) => b.textContent?.replace(/\s+/g, ' ').trim());
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain('main.ts');
  });

  it('opens the active result on Enter', async () => {
    await type('readme');
    await press('Enter');
    expect(selected).toEqual(['README.md']);
  });

  it('moves the selection with the arrow keys before opening', async () => {
    await type('app'); // matches app.ts then main.ts (path hit)
    await press('ArrowDown');
    await press('Enter');
    expect(selected).toEqual(['src/app/main.ts']);
  });

  it('opens a file when its row is clicked', async () => {
    await type('main');
    rows()[0].click();
    expect(selected).toEqual(['src/app/main.ts']);
  });

  it('dismisses on Escape', async () => {
    await press('Escape');
    expect(closedCount).toBe(1);
  });
});
