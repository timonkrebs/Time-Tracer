/**
 * Composes the Age tab's separate SVG charts into one standalone SVG document
 * and rasterizes it to a PNG — so a code-survival report can be saved as an
 * image. `composeStackedSvg` is pure (markup in, markup out) and testable;
 * `svgToPngBlob` does the browser-only canvas rasterization.
 */

/** One chart fragment to stack: its coordinate space and serialized children. */
export interface SvgChartFragment {
  /** Section title drawn above the chart (rendered upper-cased), if any. */
  readonly title?: string;
  /** Intrinsic width of the fragment's coordinate space (its viewBox width). */
  readonly viewBoxW: number;
  /** Intrinsic height of the fragment's coordinate space (its viewBox height). */
  readonly viewBoxH: number;
  /** Serialized inner SVG markup — the chart `<svg>`'s children. */
  readonly inner: string;
}

export interface ComposeOptions {
  /** Output width in px (the export's coordinate width). */
  readonly width?: number;
  /** Outer padding in px. */
  readonly padding?: number;
  /** Vertical gap between charts in px. */
  readonly gap?: number;
  /** Height reserved for a chart's section title in px. */
  readonly titleHeight?: number;
  /** Optional document header (e.g. the repo name). */
  readonly header?: string;
  /** Height reserved for the header in px. */
  readonly headerHeight?: number;
  readonly background?: string;
  readonly textColor?: string;
  readonly mutedColor?: string;
}

export interface ComposedSvg {
  readonly markup: string;
  readonly width: number;
  readonly height: number;
}

const DEFAULTS = {
  width: 720,
  padding: 20,
  gap: 18,
  titleHeight: 22,
  headerHeight: 34,
  background: '#09090b',
  textColor: '#e4e4e7',
  mutedColor: '#a1a1aa',
} as const;

const FONT = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

/**
 * Stacks `fragments` vertically into one SVG of fixed width, each scaled
 * uniformly to the content width and preceded by its title, under an optional
 * header. Charts keep their own (self-contained, hex-coloured) markup, so the
 * result rasterizes faithfully without external styles.
 */
export function composeStackedSvg(
  fragments: readonly SvgChartFragment[],
  options: ComposeOptions = {},
): ComposedSvg {
  const o = { ...DEFAULTS, ...options };
  const contentW = o.width - o.padding * 2;
  const parts: string[] = [];
  let y = o.padding;

  if (o.header) {
    parts.push(
      text(o.padding, y + o.headerHeight * 0.7, escapeXml(o.header), {
        size: 16,
        weight: '600',
        fill: o.textColor,
      }),
    );
    y += o.headerHeight;
  }

  for (const fragment of fragments) {
    if (fragment.title) {
      parts.push(
        text(o.padding, y + o.titleHeight * 0.7, escapeXml(fragment.title.toUpperCase()), {
          size: 11,
          weight: '500',
          fill: o.mutedColor,
          letterSpacing: '0.05em',
        }),
      );
      y += o.titleHeight;
    }
    const scale = fragment.viewBoxW > 0 ? contentW / fragment.viewBoxW : 1;
    parts.push(
      `<g transform="translate(${o.padding} ${r(y)}) scale(${r(scale)})">${fragment.inner}</g>`,
    );
    y += fragment.viewBoxH * scale + o.gap;
  }

  const height = Math.max(r(y - o.gap + o.padding), o.padding * 2);
  const markup =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${o.width}" height="${height}" ` +
    `viewBox="0 0 ${o.width} ${height}">` +
    `<rect width="100%" height="100%" fill="${o.background}"/>` +
    parts.join('') +
    `</svg>`;
  return { markup, width: o.width, height };
}

/** Rasterizes standalone SVG `markup` to a PNG Blob via an offscreen canvas. */
export async function svgToPngBlob(
  markup: string,
  width: number,
  height: number,
  scale = 2,
): Promise<Blob> {
  const image = await loadImage('data:image/svg+xml;base64,' + base64Utf8(markup));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.scale(scale, scale);
  ctx.drawImage(image, 0, 0, width, height);
  return await canvasToBlob(canvas);
}

function text(
  x: number,
  y: number,
  content: string,
  opts: { size: number; weight: string; fill: string; letterSpacing?: string },
): string {
  const spacing = opts.letterSpacing ? ` letter-spacing="${opts.letterSpacing}"` : '';
  return (
    `<text x="${r(x)}" y="${r(y)}" font-family="${FONT}" font-size="${opts.size}" ` +
    `font-weight="${opts.weight}" fill="${opts.fill}"${spacing}>${content}</text>`
  );
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to render the chart SVG'));
    image.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))),
      'image/png',
    );
  });
}

/** Base64 that survives non-ASCII (author names) — UTF-8 bytes then btoa. */
function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  // Build in chunks: char-by-char concatenation is O(n²) for a large SVG, and
  // spreading the whole array into fromCharCode can overflow the call stack.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function escapeXml(value: string): string {
  return value.replace(
    /[<>&"']/g,
    (char) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char] ?? char,
  );
}

/** Rounds to 2 decimals to keep the composed markup compact. */
function r(value: number): number {
  return Math.round(value * 100) / 100;
}
