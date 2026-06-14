import { copyText } from './clipboard';

describe('copyText', () => {
  const originalClipboard = navigator.clipboard;
  const originalExec = (document as { execCommand?: unknown }).execCommand;

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
    Object.defineProperty(document, 'execCommand', { value: originalExec, configurable: true });
    vi.restoreAllMocks();
  });

  function stubClipboard(writeText: ((text: string) => Promise<void>) | undefined): void {
    const value = writeText ? { writeText } : undefined;
    Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
  }

  function stubExec(result: boolean): ReturnType<typeof vi.fn> {
    const exec = vi.fn().mockReturnValue(result);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    return exec;
  }

  it('writes through the async Clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    await expect(copyText('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand when the Clipboard API rejects', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')));
    const exec = stubExec(true);

    await expect(copyText('hi')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('reports failure when neither path works', async () => {
    stubClipboard(undefined);
    stubExec(false);

    await expect(copyText('nope')).resolves.toBe(false);
  });

  it('removes the fallback textarea even when execCommand throws', async () => {
    stubClipboard(undefined);
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn(() => {
        throw new Error('boom');
      }),
      configurable: true,
    });

    await expect(copyText('x')).resolves.toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });
});
