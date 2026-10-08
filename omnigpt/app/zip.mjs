// Minimal zip writer and reader (no zip64: entries and archives up to 4 GB). Used by the archive tool and to build
// Office files (docx, xlsx, pptx are zip packages of XML).
import zlib from "node:zlib";

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export const crc32 = zlib.crc32 || ((buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; });

const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
const dosDate = (d) => (((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

// files: [{ name: "folder/file.txt" (forward slashes; a trailing slash makes a folder), data: Buffer|string, mtime?: Date }]
export function zipBuild(files, level = 6) {
  const locals = [], centrals = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name.replace(/\\/g, "/"), "utf8"), dir = f.name.endsWith("/");
    const raw = dir ? Buffer.alloc(0) : Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data ?? ""), "utf8");
    const deflated = raw.length ? zlib.deflateRawSync(raw, { level }) : raw;
    const store = !raw.length || deflated.length >= raw.length, data = store ? raw : deflated;
    if (offset + data.length > 0xfffffff0 || raw.length > 0xfffffff0) throw new Error("archive too large (over 4 GB); use 7-Zip");
    const crc = raw.length ? crc32(raw) : 0, d = f.mtime || new Date(), method = store ? 0 : 8;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime(d), 10); lh.writeUInt16LE(dosDate(d), 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dosTime(d), 12); ch.writeUInt16LE(dosDate(d), 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(dir ? 0x10 : 0, 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, data); centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// Reads the central directory. read(entry) returns the entry's bytes (up to maxBytes).
export function zipRead(buf) {
  let e = buf.length - 22;
  while (e >= 0 && e >= buf.length - 65557 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0 || buf.readUInt32LE(e) !== 0x06054b50) throw new Error("not a zip archive (or a zip64 archive, which needs 7-Zip)");
  const count = buf.readUInt16LE(e + 10), entries = [];
  let p = buf.readUInt32LE(e + 16);
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nlen);
    entries.push({ name, size, csize, method, local, crc, encrypted: !!(flags & 1), dir: name.endsWith("/") });
    p += 46 + nlen + xlen + clen;
  }
  const read = (ent, maxBytes = 2 * 1024 * 1024 * 1024) => {
    if (ent.encrypted) throw new Error("password-protected entry");
    if (ent.size > maxBytes) throw new Error("entry too large");
    const l = ent.local, start = l + 30 + buf.readUInt16LE(l + 26) + buf.readUInt16LE(l + 28), data = buf.subarray(start, start + ent.csize);
    const out = ent.method === 0 ? data : ent.method === 8 ? zlib.inflateRawSync(data) : null;
    if (!out) throw new Error("unsupported compression method " + ent.method + " (use 7-Zip)");
    if (out.length !== ent.size || (ent.size && crc32(out) !== ent.crc)) throw new Error("damaged entry " + ent.name);
    return out;
  };
  return { entries, read };
}
