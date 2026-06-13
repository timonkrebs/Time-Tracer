import { heatLevel } from '../../core/util/hotspots';
import { HEAT_STYLES } from './heat';

describe('HEAT_STYLES', () => {
  it('has a badge and swatch class for every heat level heatLevel can return', () => {
    expect(HEAT_STYLES).toHaveLength(5);
    // Probe scores across every bucket boundary; each must index a full style.
    for (const score of [0, 0.75, 2, 4, 8, 1000]) {
      const style = HEAT_STYLES[heatLevel(score)];
      expect(style).toBeDefined();
      expect(style.badge).toBeTruthy();
      expect(style.swatch).toBeTruthy();
    }
  });
});
