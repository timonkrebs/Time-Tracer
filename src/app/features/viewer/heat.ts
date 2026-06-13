/**
 * Heat palette for hotspot heat levels (0 = cold … 4 = hot), shared by the
 * file-tree badges and the {@link ./heat-popup HeatPopup} card so the two
 * never drift. `badge` carries background + text colour for the per-file
 * badge; `swatch` is a more saturated background-only fill for the popup's
 * heat scale; `label` names the band for the popup.
 */
export const HEAT_STYLES: readonly {
  readonly badge: string;
  readonly swatch: string;
  readonly label: string;
}[] = [
  { badge: 'bg-zinc-800 text-zinc-500', swatch: 'bg-zinc-600', label: 'Cold' },
  { badge: 'bg-sky-500/15 text-sky-300', swatch: 'bg-sky-500/70', label: 'Cool' },
  { badge: 'bg-amber-500/15 text-amber-300', swatch: 'bg-amber-500/80', label: 'Warm' },
  { badge: 'bg-orange-500/20 text-orange-300', swatch: 'bg-orange-500/90', label: 'Hot' },
  { badge: 'bg-rose-500/25 text-rose-200', swatch: 'bg-rose-500', label: 'Very hot' },
];
