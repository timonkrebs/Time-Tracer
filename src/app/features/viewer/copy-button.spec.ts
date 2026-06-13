import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CopyButton } from './copy-button';

describe('CopyButton', () => {
  let fixture: ComponentFixture<CopyButton>;
  const original = navigator.clipboard;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CopyButton],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    fixture = TestBed.createComponent(CopyButton);
    fixture.componentRef.setInput('value', 'payload');
    fixture.componentRef.setInput('label', 'Copy link');
    await fixture.whenStable();
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true });
  });

  function button(): HTMLButtonElement {
    return fixture.nativeElement.querySelector('button') as HTMLButtonElement;
  }

  it('copies the value and confirms', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    expect(button().textContent?.trim()).toBe('Copy link');
    button().click();
    await fixture.whenStable();

    expect(writeText).toHaveBeenCalledWith('payload');
    expect(button().textContent?.trim()).toBe('Copied!');
  });
});
