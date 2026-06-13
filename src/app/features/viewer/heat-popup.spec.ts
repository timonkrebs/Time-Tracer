import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { FileMetric } from '../../core/util/hotspots';
import { HeatPopup } from './heat-popup';

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

describe('HeatPopup', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });

  function render(m: FileMetric): string {
    const fixture = TestBed.createComponent(HeatPopup);
    fixture.componentRef.setInput('metric', m);
    fixture.detectChanges();
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  it('shows the band, score, change summary and the newest and oldest commit', () => {
    const text = render(metric({ score: 6 }));
    expect(text).toContain('Hot'); // score 6 → level 3
    expect(text).toContain('score 6.0');
    expect(text).toContain('5 changes');
    expect(text).toContain('2 authors');
    expect(text).toContain('Newest change');
    expect(text).toContain('01.06.2026');
    expect(text).toContain('Oldest change');
    expect(text).toContain('01.01.2026');
  });

  it('explains how the colour is derived and names the band score range', () => {
    const text = render(metric({ score: 6 }));
    expect(text).toContain('recency-weighted change score');
    expect(text).toContain('Hot 4–8'); // current band and its score range
  });

  it('labels the hottest band as ≥ 8 and the coldest as < 0.75', () => {
    expect(render(metric({ score: 20 }))).toContain('Very hot ≥ 8');
    expect(render(metric({ score: 0.2 }))).toContain('Cold < 0.75');
  });

  it('marks a partial metric and relabels the oldest row', () => {
    const text = render(metric({ partial: true }));
    expect(text).toContain('≥ 5 changes');
    expect(text).toContain('Oldest loaded');
  });
});
