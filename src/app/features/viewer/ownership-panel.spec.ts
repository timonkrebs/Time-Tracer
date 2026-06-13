import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { FolderOwnershipState } from '../../core/store/repo-store';
import { OwnedLine, summarizeOwnership } from '../../core/util/ownership';
import { OwnershipPanel } from './ownership-panel';

function line(authorName: string): OwnedLine {
  return { commit: { sha: authorName, authorName, authoredAt: '2020-01-01T00:00:00Z' } };
}

const FILE_SUMMARY = summarizeOwnership([line('Ada'), line('Ada'), line('Ada'), line('Bob')]);

describe('OwnershipPanel', () => {
  let fixture: ComponentFixture<OwnershipPanel>;
  let scanned: number;
  let cleared: number;
  let closed: number;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OwnershipPanel],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    fixture = TestBed.createComponent(OwnershipPanel);
    fixture.componentRef.setInput('path', 'src/app/main.ts');
    fixture.componentRef.setInput('folderPath', 'src/app');
    scanned = cleared = closed = 0;
    fixture.componentInstance.scanFolder.subscribe(() => scanned++);
    fixture.componentInstance.clearFolder.subscribe(() => cleared++);
    fixture.componentInstance.closed.subscribe(() => closed++);
    await fixture.whenStable();
  });

  function text(): string {
    return (fixture.nativeElement.textContent ?? '').replace(/\s+/g, ' ');
  }

  function button(label: string): HTMLButtonElement | undefined {
    return Array.from(fixture.nativeElement.querySelectorAll('button') as HTMLButtonElement[]).find(
      (b) => b.textContent?.includes(label),
    );
  }

  it('shows the file name and a prompt before blame is folded', () => {
    expect(text()).toContain('main.ts');
    expect(text()).toContain('Annotating this file');
  });

  it('surfaces the reason when blame is unavailable rather than annotating forever', async () => {
    fixture.componentRef.setInput('blameUnavailable', 'Blame is only available for text files.');
    await fixture.whenStable();
    expect(text()).toContain('Blame is only available for text files.');
    expect(text()).not.toContain('Annotating this file');
  });

  it('renders per-author shares and the bus factor once a summary is set', async () => {
    fixture.componentRef.setInput('fileSummary', FILE_SUMMARY);
    await fixture.whenStable();
    const t = text();
    expect(t).toContain('Ada');
    expect(t).toContain('Bob');
    expect(t).toContain('Bus factor 1'); // Ada owns 75%
  });

  it('offers a folder scan and emits when triggered', async () => {
    const scan = button('Scan this folder');
    expect(scan).toBeTruthy();
    scan!.click();
    expect(scanned).toBe(1);
  });

  it('renders a folder result for the current folder, with a clear action', async () => {
    const folder: FolderOwnershipState = {
      status: 'ready',
      path: 'src/app',
      summary: FILE_SUMMARY,
      filesTotal: 2,
      filesScanned: 2,
      capped: false,
    };
    fixture.componentRef.setInput('folder', folder);
    await fixture.whenStable();
    expect(text()).toContain('2 files scanned');

    button('Clear')!.click();
    expect(cleared).toBe(1);
  });

  it('ignores a folder result from a different folder', async () => {
    const folder: FolderOwnershipState = {
      status: 'ready',
      path: 'docs',
      summary: FILE_SUMMARY,
      filesTotal: 1,
      filesScanned: 1,
      capped: false,
    };
    fixture.componentRef.setInput('folder', folder);
    await fixture.whenStable();
    // Still showing the scan prompt, not the stale result.
    expect(button('Scan this folder')).toBeTruthy();
  });

  it('emits closed from the header button', () => {
    const close = fixture.nativeElement.querySelector(
      '[aria-label="Close ownership panel"]',
    ) as HTMLButtonElement;
    close.click();
    expect(closed).toBe(1);
  });
});
