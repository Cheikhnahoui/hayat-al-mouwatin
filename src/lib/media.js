'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const db = require('../db');
const config = require('../config');

fs.mkdirSync(config.uploadDir, { recursive: true });

// detect real type from magic bytes (never trust client mime / extension)
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'image', mime: 'image/jpeg' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image', mime: 'image/png' };
  if (buf.slice(0, 4).toString('ascii') === 'GIF8') return { kind: 'image', mime: 'image/gif' };
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') return { kind: 'video', mime: 'video/mp4', ext: 'mp4' };
  if (buf.slice(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { kind: 'video', mime: 'video/webm', ext: 'webm' };
  return null;
}

async function saveUpload(file, userId, folder = 'general') {
  const t = sniff(file.buffer);
  if (!t) throw new Error('unsupported');
  if (t.kind === 'image' && file.size > config.maxImageBytes) throw new Error('too_large');
  if (t.kind === 'video' && file.size > config.maxVideoBytes) throw new Error('too_large');
  const base = crypto.randomBytes(12).toString('hex');
  const original = String(file.originalname || '').replace(/[^\p{L}\p{N}._ -]/gu, '').slice(0, 120);
  let rec;
  if (t.kind === 'image') {
    const img = sharp(file.buffer, { failOn: 'error', limitInputPixels: 60e6 }).rotate(); // auto-orient, strips EXIF on output
    const meta = await sharp(file.buffer).metadata();
    const keepGif = t.mime === 'image/gif' && meta.pages > 1;
    const main = `${base}.webp`;
    const thumb = `${base}-400.webp`, medium = `${base}-900.webp`;
    if (keepGif) {
      const gif = `${base}.gif`;
      fs.writeFileSync(path.join(config.uploadDir, gif), file.buffer);
      await img.clone().resize({ width: 400, withoutEnlargement: true }).webp({ quality: 78 }).toFile(path.join(config.uploadDir, thumb));
      rec = { file: gif, thumb, medium: gif, mime: 'image/gif', w: meta.width, h: meta.height, size: file.size };
    } else {
      const out = await img.clone().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toFile(path.join(config.uploadDir, main));
      await img.clone().resize({ width: 900, withoutEnlargement: true }).webp({ quality: 80 }).toFile(path.join(config.uploadDir, medium));
      await img.clone().resize({ width: 400, withoutEnlargement: true }).webp({ quality: 76 }).toFile(path.join(config.uploadDir, thumb));
      rec = { file: main, thumb, medium, mime: 'image/webp', w: out.width, h: out.height, size: out.size };
    }
  } else {
    const main = `${base}.${t.ext}`;
    fs.writeFileSync(path.join(config.uploadDir, main), file.buffer);
    rec = { file: main, thumb: null, medium: null, mime: t.mime, w: null, h: null, size: file.size };
  }
  const info = db.prepare(`INSERT INTO media (kind, file, thumb, medium, original_name, mime, size, width, height, folder, uploaded_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(t.kind, rec.file, rec.thumb, rec.medium, original, rec.mime, rec.size, rec.w, rec.h, folder, userId);
  return db.prepare('SELECT * FROM media WHERE id = ?').get(info.lastInsertRowid);
}

function deleteMediaFiles(m) {
  for (const f of new Set([m.file, m.thumb, m.medium].filter(Boolean))) {
    try { fs.unlinkSync(path.join(config.uploadDir, path.basename(f))); } catch { /* already gone */ }
  }
}

const url = (m, size = 'file') => (m ? '/uploads/' + (m[size] || m.file) : null);

module.exports = { saveUpload, deleteMediaFiles, url, sniff };
