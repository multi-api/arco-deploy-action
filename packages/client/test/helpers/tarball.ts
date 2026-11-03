import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export interface TarEntry {
  name: string;
  /** '0' file (default), '5' directory, '2' symlink, '1' hard link. */
  type?: '0' | '1' | '2' | '5';
  content?: string;
  linkname?: string;
}

/** A minimal ustar writer, so tests can build archives a normal `tar -c` refuses to (`..`, absolute paths, links). */
export function tarball(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? '0';
    const body = Buffer.from(type === '0' ? (entry.content ?? '') : '');
    const header = Buffer.alloc(512);
    const put = (value: string, offset: number, length: number) => header.write(value, offset, length, 'utf8');
    const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, '0') + '\0';
    put(entry.name, 0, 100);
    put(octal(type === '5' ? 0o755 : 0o644, 8), 100, 8);
    put(octal(0, 8), 108, 8);
    put(octal(0, 8), 116, 8);
    put(octal(body.length, 12), 124, 12);
    put(octal(0, 12), 136, 12);
    put('        ', 148, 8);
    put(type, 156, 1);
    put(entry.linkname ?? '', 157, 100);
    put('ustar\0', 257, 6);
    put('00', 263, 2);
    let sum = 0;
    for (const byte of header) sum += byte;
    put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
