// A small ZIP writer (deflate), using only what Node provides. Enough for the
// year-end package: a few documents and the year's receipts.
import zlib from 'node:zlib';

export interface ZipEntry {
  name: string; // path inside the archive, with forward slashes
  data: Buffer;
  date?: Date;
}

function dosTime(date: Date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const crc = zlib.crc32(entry.data) >>> 0;
    // Photos and PDFs barely shrink, so they're stored as they are.
    const deflated = zlib.deflateRawSync(entry.data);
    const store = deflated.length >= entry.data.length;
    const body = store ? entry.data : deflated;
    const { time, day } = dosTime(entry.date || new Date());
    const flags = 0x0800; // names are UTF-8
    const method = store ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(day, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// The entries of a ZIP this writer made, for tests.
export function unzip(archive: Buffer): ZipEntry[] {
  const out: ZipEntry[] = [];
  let at = 0;
  while (archive.readUInt32LE(at) === 0x04034b50) {
    const method = archive.readUInt16LE(at + 8);
    const size = archive.readUInt32LE(at + 18);
    const nameLength = archive.readUInt16LE(at + 26);
    const extra = archive.readUInt16LE(at + 28);
    const name = archive.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const body = archive.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + size);
    out.push({ name, data: method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body) });
    at += 30 + nameLength + extra + size;
  }
  return out;
}
