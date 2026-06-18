import { csvCell, fileSlug, round, toCsv, toJson } from './data-export';

describe('csvCell', () => {
  it('passes plain values through', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(3)).toBe('3');
    expect(csvCell(true)).toBe('true');
  });

  it('renders nullish and non-finite numbers as empty', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(Infinity)).toBe('');
    expect(csvCell(NaN)).toBe('');
  });

  it('quotes and escapes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('has "q"')).toBe('"has ""q"""');
    expect(csvCell('x\ny')).toBe('"x\ny"');
  });
});

describe('toCsv', () => {
  it('joins a header row and value rows with CRLF', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          [1, 2],
          [3, 4],
        ],
      ),
    ).toBe('a,b\r\n1,2\r\n3,4');
  });

  it('escapes cells per row', () => {
    expect(toCsv(['name'], [['a,b']])).toBe('name\r\n"a,b"');
  });

  it('handles no rows', () => {
    expect(toCsv(['a', 'b'], [])).toBe('a,b');
  });
});

describe('round', () => {
  it('rounds to three decimals by default', () => {
    expect(round(1.23456)).toBe(1.235);
    expect(round(2)).toBe(2);
  });

  it('honours a custom precision', () => {
    expect(round(1.23456, 4)).toBe(1.2346);
    expect(round(0.5, 0)).toBe(1);
  });

  it('maps non-finite values to 0', () => {
    expect(round(Infinity)).toBe(0);
    expect(round(NaN)).toBe(0);
  });
});

describe('toJson', () => {
  it('pretty-prints with two-space indent', () => {
    expect(toJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

describe('fileSlug', () => {
  it('lower-cases and dashes non-alphanumerics', () => {
    expect(fileSlug('microsoft/vscode')).toBe('microsoft-vscode');
    expect(fileSlug('  Foo Bar!! ')).toBe('foo-bar');
  });

  it('falls back to "repository" for empty input', () => {
    expect(fileSlug('')).toBe('repository');
    expect(fileSlug('---')).toBe('repository');
  });
});
