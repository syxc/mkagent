import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { trashFixture } from './fixtures/trash-fixture.ts';

afterEach(() => { mock.restore(); });

test('fixture cleanup uses PATH and keeps successful trash quiet', () => {
  const spawn = spyOn(Bun, 'spawnSync').mockReturnValue({ exitCode: 0 } as ReturnType<typeof Bun.spawnSync>);
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  trashFixture('/fixture');
  expect(spawn).toHaveBeenCalledWith(['trash', '/fixture']);
  expect(warn).not.toHaveBeenCalled();
});

test('missing trash retains the fixture without masking assertions', () => {
  spyOn(Bun, 'spawnSync').mockImplementation(() => { throw Object.assign(new Error('Missing trash'), { code: 'ENOENT' }); });
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  expect(() => trashFixture('/fixture')).not.toThrow();
  expect(warn).toHaveBeenCalledWith('Temporary fixture retained: /fixture');
});

test('a failing trash process reports the retained fixture', () => {
  spyOn(Bun, 'spawnSync').mockReturnValue({ exitCode: 1 } as ReturnType<typeof Bun.spawnSync>);
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  expect(() => trashFixture('/fixture')).not.toThrow();
  expect(warn).toHaveBeenCalledWith('Temporary fixture retained: /fixture');
});
