import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep, win32 } from 'node:path';

/** The installer provides a fresh directory; never merge archive data with existing paths. */
export async function extractZipArchive(archivePath: string, extractDir: string, assetName: string): Promise<void> {
  try {
    const { default: JSZip } = await import('jszip');
    const archive = await JSZip.loadAsync(await readFile(archivePath), { checkCRC32: true });
    const root = await realpath(extractDir);
    if ((await readdir(root)).length) throw new Error('The tool extraction directory is not empty');
    const files = Object.values(archive.files).map(entry => {
      const name = (entry.unsafeOriginalName ?? entry.name).replaceAll('\\', '/');
      const path = resolve(root, name);
      const mode = typeof entry.unixPermissions === 'string'
        ? Number.parseInt(entry.unixPermissions, 8) : entry.unixPermissions ?? 0;
      const type = mode & 0o170000;
      if (isAbsolute(name) || win32.isAbsolute(name) || /^[a-z]:/i.test(name) ||
          name.includes('\0') || name.split('/').includes('..') ||
          (path !== root && !path.startsWith(root + sep)) ||
          (type && type !== 0o100000 && type !== 0o040000)) {
        throw new Error(`Unsupported ZIP entry: ${entry.name}`);
      }
      return { entry, path };
    });
    for (const { entry, path } of files) {
      if (entry.dir) await mkdir(path, { recursive: true });
      else {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, await entry.async('nodebuffer'), { flag: 'wx' });
      }
    }
  } catch (error) {
    throw new Error(`Failed to extract ${assetName}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
