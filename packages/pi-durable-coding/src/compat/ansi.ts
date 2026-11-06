import ansiRegex from 'ansi-regex';

// Add Native private CSI prefixes in the same pass, so removal cannot expose a new sequence.
const privateCsi = /(?:\u001B\[|\u009B)[<=>](?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/;
export const nativeAnsiRegex = new RegExp(`${privateCsi.source}|${ansiRegex().source}`, 'g');
