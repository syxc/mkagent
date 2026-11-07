import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { stripAnsi, splitIncompleteAnsiSuffix } from '../src/pi/utils/ansi.ts';

const esc = '\x1b';
const cases: [string, string, string][] = [
  ['empty', '', ''],
  ['plain', 'plain', 'plain'],
  ['SGR', `${esc}[31mX${esc}[0m`, 'X'],
  ['colon SGR', `${esc}[38:2:1:2:3mX`, 'X'],
  ['private mouse', `${esc}[<35;59;1MX`, 'X'],
  ['private equals', `${esc}[=1mX`, 'X'],
  ['private greater', `${esc}[>1mX`, 'X'],
  ['keypad equals', `${esc}=123`, '123'],
  ['keypad greater', `${esc}>123`, '123'],
  ['C1 SGR', '\x9b31mX\x9b0m', 'X'],
  ['C1 unmatched', '\x9bYX', '\x9bYX'],
  ['cursor up', `${esc}[2AX`, 'X'],
  ['cursor previous', `${esc}[2FX`, 'X'],
  ['cursor erase', `${esc}[2KX`, 'X'],
  ['OSC BEL', `${esc}]0;title\x07X`, 'X'],
  ['OSC ST', `${esc}]0;title${esc}\\X`, 'X'],
  ['OSC C1 ST', `${esc}]0;title\x9cX`, 'X'],
  ['OSC unicode', `${esc}]0;你好👩\x07X`, 'X'],
  ['OSC newline', `${esc}]0;title\nnext\x07X`, 'X'],
  ['OSC earliest end', `${esc}]0;first\x07middle\x07X`, 'middle\x07X'],
  ['APC retained', `${esc}_payload${esc}\\X`, `${esc}_payload${esc}\\X`],
  ['invalid CSI text', `${esc}[garbagemX`, 'arbagemX'],
  ['five digits', `${esc}[12345mX`, 'mX'],
  ['incomplete OSC', `${esc}]title`, 'itle'],
  ['incomplete CSI', `${esc}[31`, ''],
  ['lone ESC', esc, esc],
];
test.each(cases)('Native ANSI retains the original result: %s', (_name, input, expected) => {
  expect(stripAnsi(input)).toBe(expected);
});

test('Native ANSI retains type errors for JavaScript callers', () => {
  for (const input of [null, undefined, 0, {}, []]) {
    expect(() => Reflect.apply(stripAnsi, undefined, [input]))
      .toThrow(new TypeError(`Expected a \`string\`, got \`${typeof input}\``));
  }
});

test('Native ANSI retains valid sequences across every stream cut', () => {
  const names = ['SGR', 'colon SGR', 'private mouse', 'private equals', 'private greater',
    'C1 SGR', 'cursor up', 'cursor previous', 'cursor erase', 'OSC BEL',
    'OSC ST', 'OSC C1 ST', 'OSC unicode', 'OSC newline'];
  for (const [name, input, expected] of cases.filter(([name]) => names.includes(name))) {
    for (let cut = 0; cut <= input.length; cut++) {
      const first = splitIncompleteAnsiSuffix(input.slice(0, cut));
      const second = splitIncompleteAnsiSuffix(first.pending + input.slice(cut));
      expect(stripAnsi(first.complete) + stripAnsi(second.complete) + stripAnsi(second.pending),
        `${name} split ${cut}`).toBe(expected);
    }
  }
});

test('Native ANSI retains the pending limit and a split OSC terminator', () => {
  for (const size of [255, 256, 257]) {
    const suffix = `${esc}]${'x'.repeat(size - 2)}`;
    expect(splitIncompleteAnsiSuffix(`A${suffix}`)).toEqual(size <= 256
      ? { complete: 'A', pending: suffix } : { complete: `A${suffix}`, pending: '' });
  }
  const prefix = `${esc}]title${esc}`;
  expect(splitIncompleteAnsiSuffix(prefix)).toEqual({ complete: '', pending: prefix });
  expect(stripAnsi(splitIncompleteAnsiSuffix(`${prefix}\\X`).complete)).toBe('X');
});

test('Native ANSI retains 3860 original malformed and adjacent sequence results', () => {
  // Captured from the pinned Native module before replacing its complete matcher.
  const hash = createHash('sha256');
  let count = 0;
  const record = (input: string) => {
    hash.update(JSON.stringify([input, stripAnsi(input)]) + '\n');
    count++;
  };
  for (const [, left] of cases) {
    for (const [, right] of cases) {
      for (const separator of ['', 'TEXT', esc, `${esc}[`, '\x9b']) record(left + separator + right);
    }
  }
  for (const prefix of [`${esc}[`, '\x9b']) {
    for (const mode of ['<', '=', '>']) {
      for (const parameters of ['', '1', '1234', '12345', '38:2::1', '1;2;3', '?1', 'a']) {
        for (const final of ['m', 'M', 'H', 'F', 'Y', 'z', '', '[', '\x07', esc]) {
          record(`left${prefix}${mode}${parameters}${final}right`);
        }
      }
    }
  }
  expect(count).toBe(3860);
  expect(hash.digest('hex')).toBe('84bd631fc44a33b5273723e2889719a099ac5183361fc85d77fa31be63e6bc20');
});
