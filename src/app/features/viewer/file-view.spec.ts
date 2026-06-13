import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { FileState } from '../../core/models';
import { FileView } from './file-view';

function textState(lineCount: number): FileState {
  const text = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join('\n');
  return {
    status: 'ready',
    path: 'big.ts',
    file: { kind: 'text', path: 'big.ts', sha: 's', size: text.length, text },
  };
}

function blameRowCount(fixture: ComponentFixture<FileView>): number {
  // Blame rows are the per-line flex divs carrying the hover background.
  return (fixture.nativeElement as HTMLElement).querySelectorAll('div[class*="hover:bg-white"]')
    .length;
}

describe('FileView blame virtualization', () => {
  let fixture: ComponentFixture<FileView>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FileView],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    fixture = TestBed.createComponent(FileView);
    fixture.componentRef.setInput('blameActive', true);
  });

  it('renders one row per line for a small blamed file', async () => {
    fixture.componentRef.setInput('state', textState(20));
    await fixture.whenStable();

    expect(blameRowCount(fixture)).toBe(20);
  });

  it('renders only a window of rows for a very large blamed file', async () => {
    fixture.componentRef.setInput('state', textState(5000));
    await fixture.whenStable();

    const rendered = blameRowCount(fixture);
    expect(rendered).toBeGreaterThan(0);
    // A tiny fraction of the file is in the DOM, not all 5000 rows.
    expect(rendered).toBeLessThan(300);
  });
});
