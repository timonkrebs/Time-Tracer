export type LoadState =
  | { status: 'idle' }
  | { status: 'parsing-url' }
  | { status: 'loading-metadata' }
  | { status: 'loading-tree' }
  | { status: 'ready' }
  | { status: 'error'; message: string; cause?: unknown };