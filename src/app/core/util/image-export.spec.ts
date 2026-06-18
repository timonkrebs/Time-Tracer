import { SvgChartFragment, composeStackedSvg } from './image-export';

function fragment(
  title: string | undefined,
  viewBoxW: number,
  viewBoxH: number,
  inner: string,
): SvgChartFragment {
  return { title, viewBoxW, viewBoxH, inner };
}

describe('composeStackedSvg', () => {
  it('wraps fragments in one sized SVG with a background and the inner markup', () => {
    const { markup, width, height } = composeStackedSvg(
      [fragment('A', 100, 50, '<rect id="x"/>')],
      {
        width: 200,
        padding: 10,
        gap: 10,
        headerHeight: 0,
      },
    );
    expect(width).toBe(200);
    expect(height).toBeGreaterThan(0);
    expect(markup.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(markup).toContain(`viewBox="0 0 200 ${height}"`);
    expect(markup).toContain('<rect width="100%" height="100%" fill="#09090b"/>');
    expect(markup).toContain('<rect id="x"/>');
  });

  it('draws the header and upper-cased titles, XML-escaped', () => {
    const { markup } = composeStackedSvg([fragment('Survival curve', 100, 40, '<g></g>')], {
      header: 'repo & co <x>',
    });
    expect(markup).toContain('SURVIVAL CURVE');
    expect(markup).toContain('repo &amp; co &lt;x&gt;');
  });

  it('scales each fragment uniformly to the content width', () => {
    const { markup } = composeStackedSvg([fragment(undefined, 200, 100, '<x/>')], {
      width: 420,
      padding: 10,
      headerHeight: 0,
    });
    // contentWidth = 420 - 2*10 = 400; scale = 400 / 200 = 2.
    expect(markup).toContain('scale(2)');
  });

  it('grows in height as fragments are added', () => {
    const one = composeStackedSvg([fragment('A', 100, 50, '')], { headerHeight: 0 });
    const two = composeStackedSvg([fragment('A', 100, 50, ''), fragment('B', 100, 50, '')], {
      headerHeight: 0,
    });
    expect(two.height).toBeGreaterThan(one.height);
  });
});
