import assert from 'node:assert/strict';
import { test } from 'node:test';
import { portPhotonRuntime } from '../scripts/asset-runtime-port.ts';
import { applySharedHelperPort } from '../scripts/shared-helper-port.ts';

const source = `
export type { PhotonImage as PhotonImageType } from "@silvia-odwyer/photon-node";
function privateLoader() { throw new Error("old CJS loader"); }
export async function loadPhoton(): Promise<typeof import("@silvia-odwyer/photon-node") | null> {
  return privateLoader();
}
`;

test('Photon forwards its public API without binding private loader bodies', () => {
  const original = portPhotonRuntime(source);
  const changed = source.replace('throw new Error("old CJS loader");', 'return null;');
  assert.notEqual(changed, source);
  assert.equal(portPhotonRuntime(changed), original);
  assert.match(original, /compat\/photon\.ts/);
  const port = applySharedHelperPort('utils/photon.ts', source);
  assert.equal(port?.body, original);
  assert.equal(port?.dependency, '@silvia-odwyer/photon');
});

for (const [name, changed] of [
  ['parameters', source.replace('loadPhoton()', 'loadPhoton(path: string)')],
  ['synchronous return', source.replace('export async function', 'export function')],
  ['nullable return', source.replace(' | null', '')],
  ['module type', source.replaceAll('@silvia-odwyer/photon-node', 'another-photon')],
  ['image alias', source.replace('as PhotonImageType', 'as DifferentImage')],
  ['runtime image export', source.replace('export type {', 'export {')],
  ['default function', source.replace('export async function', 'export default async function')],
  ['extra public surface', source + '\nexport const newApi = 1;\n'],
] as const) {
  test(`Photon generation refuses changed ${name}`, () => {
    assert.notEqual(changed, source);
    assert.throws(() => portPhotonRuntime(changed), /Native Photon public boundary changed/);
  });
}
