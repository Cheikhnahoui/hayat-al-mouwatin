'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const sharp = require('sharp');
const db = require('../db');
const config = require('../config');

// ---- storage backend: Vercel Blob when BLOB_READ_WRITE_TOKEN is set, local disk otherwise ----
const useBlob = !!config.blobToken;
function blobBase() {
  if (config.blobBaseUrl) return config.blobBaseUrl;
  // token format: vercel_blob_rw_<storeId>_<secret>
  const m = /^vercel_blob_rw_([a-z0-9]+)_/i.exec(config.blobToken);
  return m ? `https://${m[1].toLowerCase()}.public.blob.vercel-storage.com` : '';
}
const blobHost = () => (useBlob && blobBase() ? new URL(blobBase()).origin : '');
if (!useBlob) { try { fs.mkdirSync(config.uploadDir, { recursive: true }); } catch { /* read-only file system */ } }

async function storeFile(name, buffer, contentType) {
  if (useBlob) {
    const { put } = require('@vercel/blob');
    await put(`uploads/${name}`, buffer, { access: 'public', token: config.blobToken, contentType, addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 31536000 });
  } else {
    await fs.promises.writeFile(path.join(config.uploadDir, name), buffer);
  }
}
async function removeFile(name) {
  try {
    if (useBlob) { const { del } = require('@vercel/blob'); await del(`${blobBase()}/uploads/${name}`, { token: config.blobToken }); }
    else await fs.promises.unlink(path.join(config.uploadDir, path.basename(name)));
  } catch { /* already gone */ }
}
// express handler for /uploads/*
function serve() {
  if (useBlob) {
    const r = express.Router();
    r.get('/:file', (req, res) => {
      const f = path.basename(req.params.file);
      if (!/^[\w.-]+$/.test(f)) return res.status(404).end();
      res.set('Cache-Control', 'public, max-age=31536000, immutable').redirect(302, `${blobBase()}/uploads/${f}`);
    });
    return r;
  }
  return express.static(config.uploadDir, { maxAge: '30d', immutable: true, index: false, dotfiles: 'deny', setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff') });
}

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
    const img = sharp(file.buffer, { failOn: 'error', limitInputPixels: 60e6 }).rotate(); // auto-orient; output carries no EXIF
    const meta = await sharp(file.buffer).metadata();
    const keepGif = t.mime === 'image/gif' && meta.pages > 1;
    const main = `${base}.webp`, thumb = `${base}-400.webp`, medium = `${base}-900.webp`;
    const webp = (w, q) => img.clone().resize({ width: w, withoutEnlargement: true }).webp({ quality: q }).toBuffer();
    if (keepGif) {
      const gif = `${base}.gif`;
      await storeFile(gif, file.buffer, 'image/gif');
      await storeFile(thumb, await webp(400, 78), 'image/webp');
      rec = { file: gif, thumb, medium: gif, mime: 'image/gif', w: meta.width, h: meta.height, size: file.size };
    } else {
      const big = await img.clone().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
      await storeFile(main, big.data, 'image/webp');
      await storeFile(medium, await webp(900, 80), 'image/webp');
      await storeFile(thumb, await webp(400, 76), 'image/webp');
      rec = { file: main, thumb, medium, mime: 'image/webp', w: big.info.width, h: big.info.height, size: big.info.size };
    }
  } else {
    const main = `${base}.${t.ext}`;
    await storeFile(main, file.buffer, t.mime);
    rec = { file: main, thumb: null, medium: null, mime: t.mime, w: null, h: null, size: file.size };
  }
  const info = await db.prepare(`INSERT INTO media (kind, file, thumb, medium, original_name, mime, size, width, height, folder, uploaded_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(t.kind, rec.file, rec.thumb, rec.medium, original, rec.mime, rec.size, rec.w, rec.h, folder, userId);
  return (await db.prepare('SELECT * FROM media WHERE id = ?').get(info.lastInsertRowid));
}

async function deleteMediaFiles(m) {
  for (const f of new Set([m.file, m.thumb, m.medium].filter(Boolean))) await removeFile(f);
}

const url = (m, size = 'file') => (m ? '/uploads/' + (m[size] || m.file) : null);

module.exports = { saveUpload, deleteMediaFiles, url, sniff, serve, blobHost, storeFile };
