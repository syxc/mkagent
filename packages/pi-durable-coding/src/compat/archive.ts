import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep, win32 } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { Zip, type ZipInputFile } from 'fflate';

interface ZipEntry {
  name: string;
  data: string | Uint8Array;
}

/** Keep ordered, duplicate entries while the public library owns the archive format. */
export function writeZipArchive(filePath: string, entries: readonly ZipEntry[]): Promise<void> {
  if (entries.length > 65_535) throw new RangeError('A classic ZIP archive supports at most 65535 entries');
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  const mtime = new Date();
  for (const entry of entries) {
    const size = typeof entry.data === 'string' ? Buffer.byteLength(entry.data) : entry.data.byteLength;
    if (size > 0xffff_ffff) throw new RangeError('A classic ZIP entry must be smaller than 4 GiB');
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data) : Buffer.from(entry.data);
    const compressed = deflateRawSync(data);
    if (compressed.length > 0xffff_ffff) throw new RangeError('A classic ZIP entry must be smaller than 4 GiB');
    // Plain completed inputs avoid retaining a deflate window for every archive entry.
    const file: ZipInputFile = { filename: entry.name, size: data.length, crc: crc32(data), compression: 8, mtime };
    zip.add(file);
    file.ondata!(null, compressed, true);
  }
  if (chunks.reduce((size, chunk) => size + chunk.length, 0) > 0xffff_ffff) {
    throw new RangeError('The classic ZIP directory offset must be smaller than 4 GiB');
  }
  zip.end();
  return writeFile(filePath, Buffer.concat(chunks));
}

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
