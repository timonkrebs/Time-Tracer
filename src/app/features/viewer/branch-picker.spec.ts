import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { BranchesState } from '../../core/store/repo-store';
import { BranchPicker } from './branch-picker';

const READY: BranchesState = {
  status: 'ready',
  names: ['dev', 'feature/foo', 'main'],
  truncated: false,
};

describe('BranchPicker', () => {
  let fixture: ComponentFixture<BranchPicker>;
  let loads: number;
  let selected: string[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [BranchPicker],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    fixture = TestBed.createComponent(BranchPicker);
    fixture.componentRef.setInput('ref', 'main');
    fixture.componentRef.setInput('defaultBranch', 'main');
    fixture.componentRef.setInput('state', null);
    loads = 0;
    selected = [];
    fixture.componentInstance.load.subscribe(() => loads++);
    fixture.componentInstance.refSelect.subscribe((name) => selected.push(name));
    await fixture.whenStable();
  });

  function chip(): HTMLButtonElement {
    return fixture.nativeElement.querySelector('button') as HTMLButtonElement;
  }

  function rows(): HTMLButtonElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('li button'));
  }

  function filterInput(): HTMLInputElement | null {
    return fixture.nativeElement.querySelector('input');
  }

  async function open(): Promise<void> {
    chip().click();
    await fixture.whenStable();
  }

  it('shows the current ref on the chip and asks for the list on open', async () => {
    expect(chip().textContent).toContain('main');

    await open();

    expect(loads).toBe(1);
    expect(fixture.nativeElement.textContent).toContain('Loading branches…');
  });

  it('lists branches with the default pinned first and the current one checked', async () => {
    fixture.componentRef.setInput('ref', 'dev');
    fixture.componentRef.setInput('state', READY);
    await open();

    const labels = rows().map((b) => b.textContent?.replace(/\s+/g, ' ').trim());
    expect(labels[0]).toContain('main');
    expect(labels[0]).toContain('default');
    expect(rows().map((b) => b.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
  });

  it('filters branches as the query is typed', async () => {
    fixture.componentRef.setInput('state', READY);
    await open();

    const input = filterInput()!;
    input.value = 'fea';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();

    const labels = rows().map((b) => b.textContent?.replace(/\s+/g, ' ').trim());
    expect(labels).toEqual(['feature/foo']);
  });

  it('emits the chosen branch and closes', async () => {
    fixture.componentRef.setInput('state', READY);
    await open();

    rows()
      .find((b) => b.textContent?.includes('dev'))!
      .click();
    await fixture.whenStable();

    expect(selected).toEqual(['dev']);
    expect(rows()).toHaveLength(0);
  });

  it('selects the active filtered branch on Enter', async () => {
    fixture.componentRef.setInput('state', READY);
    await open();

    const input = filterInput()!;
    input.value = 'dev';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await fixture.whenStable();

    expect(selected).toEqual(['dev']);
  });

  it('closes on Escape without selecting', async () => {
    fixture.componentRef.setInput('state', READY);
    await open();

    filterInput()!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await fixture.whenStable();

    expect(selected).toEqual([]);
    expect(rows()).toHaveLength(0);
  });

  it('offers a retry after a failed load', async () => {
    fixture.componentRef.setInput('state', {
      status: 'error',
      message: 'Rate limit exhausted.',
    } satisfies BranchesState);
    await open();

    expect(fixture.nativeElement.textContent).toContain('Rate limit exhausted.');
    const buttons: HTMLButtonElement[] = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    );
    buttons.find((b) => b.textContent?.includes('Try again'))!.click();

    expect(loads).toBe(2);
  });

  it('notes when the list was cut at the provider cap', async () => {
    fixture.componentRef.setInput('state', {
      status: 'ready',
      names: ['a', 'b'],
      truncated: true,
    } satisfies BranchesState);
    await open();

    expect(fixture.nativeElement.textContent).toContain('Only the first 2 branches are listed.');
  });
});
