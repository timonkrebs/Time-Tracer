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
  let scannedAll: number;
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
    scanned = scannedAll = cleared = closed = 0;
    fixture.componentInstance.scanFolder.subscribe(() => scanned++);
    fixture.componentInstance.scanAll.subscribe(() => scannedAll++);
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
      matchedTotal: 2,
      capped: false,
      files: ['src/app/a.ts', 'src/app/b.ts'],
    };
    fixture.componentRef.setInput('folder', folder);
    await fixture.whenStable();
    expect(text()).toContain('2 files scanned');

    button('Clear')!.click();
    expect(cleared).toBe(1);
  });

  it('shows a cache-folded folder chart with no clear action', async () => {
    const folder: FolderOwnershipState = {
      status: 'ready',
      path: 'src/app',
      summary: FILE_SUMMARY,
      filesTotal: 2,
      filesScanned: 2,
      matchedTotal: 2,
      capped: false,
      files: ['src/app/a.ts', 'src/app/b.ts'],
      fromCache: true,
    };
    fixture.componentRef.setInput('folder', folder);
    await fixture.whenStable();

    // The chart is shown straight away — neither the opt-in prompt nor a Clear
    // (there is nothing to clear: it is data already on hand).
    expect(text()).toContain('2 files scanned');
    expect(button('Scan this folder')).toBeFalsy();
    expect(button('Clear')).toBeFalsy();
  });

  it('still offers an uncapped scan on a capped cache-folded chart', async () => {
    const folder: FolderOwnershipState = {
      status: 'ready',
      path: 'src/app',
      summary: FILE_SUMMARY,
      filesTotal: 2,
      filesScanned: 2,
      matchedTotal: 5,
      capped: true,
      files: ['src/app/a.ts', 'src/app/b.ts'],
      fromCache: true,
    };
    fixture.componentRef.setInput('folder', folder);
    await fixture.whenStable();

    expect(button('Clear')).toBeFalsy();
    button('Scan all 5 files')!.click();
    expect(scannedAll).toBe(1);
  });

  it('tooltips the scanned files and offers an uncapped scan when capped', async () => {
    const folder: FolderOwnershipState = {
      status: 'ready',
      path: 'src/app',
      summary: FILE_SUMMARY,
      filesTotal: 2,
      filesScanned: 2,
      matchedTotal: 5,
      capped: true,
      files: ['src/app/a.ts', 'src/app/b.ts'],
    };
    fixture.componentRef.setInput('folder', folder);
    await fixture.whenStable();

    // The "files scanned" line lists the scanned files in its tooltip.
    const tip = fixture.nativeElement.querySelector('.cursor-help') as HTMLElement;
    expect(tip.getAttribute('title')).toBe('src/app/a.ts\nsrc/app/b.ts');
    expect(text()).toContain('largest 2 of 5');

    const scanAll = button('Scan all 5 files');
    expect(scanAll).toBeTruthy();
    scanAll!.click();
    expect(scannedAll).toBe(1);
  });

  it('offers an uncapped scan up front when the folder exceeds the cap', async () => {
    fixture.componentRef.setInput('folderCap', 30);
    fixture.componentRef.setInput('folderFileCount', 42);
    await fixture.whenStable();

    const scanAll = button('Scan all 42');
    expect(scanAll).toBeTruthy();
    scanAll!.click();
    expect(scannedAll).toBe(1);
  });

  it('ignores a folder result from a different folder', async () => {
    const folder: FolderOwnershipState = {
      status: 'ready',
      path: 'docs',
      summary: FILE_SUMMARY,
      filesTotal: 1,
      filesScanned: 1,
      matchedTotal: 1,
      capped: false,
      files: ['docs/readme.md'],
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
