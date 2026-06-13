import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { HeatLegend } from './heat-legend';
import { HEAT_STYLES } from './heat';

describe('HeatLegend', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });

  it('labels the scale and its cold and hot ends', () => {
    const fixture = TestBed.createComponent(HeatLegend);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Change heat');
    expect(text).toContain('cold');
    expect(text).toContain('hot');
  });

  it('draws one gradient swatch per heat level, coldest first', () => {
    const fixture = TestBed.createComponent(HeatLegend);
    fixture.detectChanges();
    const swatches = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(
        'span[aria-hidden="true"] > span',
      ),
    );
    expect(swatches).toHaveLength(HEAT_STYLES.length);
    expect(swatches[0].className).toContain('bg-zinc-600'); // coldest
    expect(swatches.at(-1)!.className).toContain('bg-rose-500'); // hottest
  });
});
