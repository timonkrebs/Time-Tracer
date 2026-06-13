import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TreeNode } from '../../core/models';
import { FileMetric } from '../../core/util/hotspots';
import { FileTree } from './file-tree';

function fileNode(path: string): TreeNode {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'file', sha: `sha-${path}` };
}

function dirNode(path: string, children: TreeNode[]): TreeNode {
  return {
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    kind: 'dir',
    sha: `sha-${path}`,
    children,
  };
}

function metric(overrides: Partial<FileMetric> = {}): FileMetric {
  return {
    revisions: 5,
    score: 6,
    lastChange: '2026-06-01T00:00:00Z',
    firstChange: '2026-01-01T00:00:00Z',
    authors: 2,
    partial: false,
    ...overrides,
  };
}

describe('FileTree', () => {
  let fixture: ComponentFixture<FileTree>;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });

  function render(
    nodes: TreeNode[],
    metrics?: ReadonlyMap<string, FileMetric>,
    expanded: Set<string> = new Set(),
  ): void {
    fixture = TestBed.createComponent(FileTree);
    fixture.componentRef.setInput('nodes', nodes);
    fixture.componentRef.setInput('expanded', expanded);
    if (metrics) fixture.componentRef.setInput('metrics', metrics);
    fixture.detectChanges();
  }

  function badges(): HTMLElement[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.heat-badge'),
    );
  }

  function popup(): HTMLElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector('app-heat-popup');
  }

  it('renders file and directory names', () => {
    render(
      [dirNode('src', [fileNode('src/a.ts')]), fileNode('README.md')],
      undefined,
      new Set(['src']),
    );
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('src');
    expect(text).toContain('a.ts');
    expect(text).toContain('README.md');
  });

  it('badges a file that has a metric with its recency-weighted score', () => {
    render([fileNode('README.md')], new Map([['README.md', metric({ score: 6 })]]));
    expect(badges()).toHaveLength(1);
    expect(badges()[0].textContent?.trim()).toBe('6.0');

    // Scores of ten or more are rounded to an integer to stay compact.
    render([fileNode('README.md')], new Map([['README.md', metric({ score: 12.4 })]]));
    expect(badges()[0].textContent?.trim()).toBe('12');
  });

  it('colours the badge from cold (low score) to hot (high score)', () => {
    render([fileNode('a.ts')], new Map([['a.ts', metric({ score: 0.5 })]]));
    expect(badges()[0].className).toContain('bg-zinc-800');

    render([fileNode('a.ts')], new Map([['a.ts', metric({ score: 12 })]]));
    expect(badges()[0].className).toContain('bg-rose-500/25');
  });

  it('omits the badge for files without a metric', () => {
    render([fileNode('README.md')], new Map());
    expect(badges()).toHaveLength(0);
  });

  it('omits the badge for a metric with no recorded revisions', () => {
    render([fileNode('README.md')], new Map([['README.md', metric({ revisions: 0 })]]));
    expect(badges()).toHaveLength(0);
  });

  it('summarises revisions, recency, authors and partiality in the aria-label', () => {
    render(
      [fileNode('README.md')],
      new Map([['README.md', metric({ revisions: 5, score: 3, authors: 2, partial: true })]]),
    );
    const label = badges()[0].getAttribute('aria-label') ?? '';
    expect(label).toContain('≥ 5 changes');
    expect(label).toContain('recency-weighted 3.0');
    expect(label).toContain('last changed');
    expect(label).toContain('2 authors');
  });

  it('reveals a details popup while the badge is hovered and hides it on leave', () => {
    render([fileNode('README.md')], new Map([['README.md', metric()]]));
    expect(popup()).toBeNull();

    badges()[0].dispatchEvent(new MouseEvent('mouseenter'));
    fixture.detectChanges();
    expect(popup()).not.toBeNull();

    badges()[0].dispatchEvent(new MouseEvent('mouseleave'));
    fixture.detectChanges();
    expect(popup()).toBeNull();
  });

  it('passes metrics down to nested files in expanded directories', () => {
    render(
      [dirNode('src', [fileNode('src/a.ts')])],
      new Map([['src/a.ts', metric({ score: 4 })]]),
      new Set(['src']),
    );
    // The directory row itself is never badged; only the nested file is.
    expect(badges()).toHaveLength(1);
    expect(badges()[0].textContent?.trim()).toBe('4.0');
  });
});
