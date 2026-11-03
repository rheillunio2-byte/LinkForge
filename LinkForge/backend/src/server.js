import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 4000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
const dataFile = process.env.DATA_FILE || path.join(__dirname, '../data/links.json');

// Lightweight JSON persistence avoids native Node addons and works on Windows without C++ build tools.
fs.mkdirSync(path.dirname(dataFile), { recursive: true });
if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, JSON.stringify({ links: [], clicks: [] }, null, 2));
function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    return { links: Array.isArray(parsed.links) ? parsed.links : [], clicks: Array.isArray(parsed.clicks) ? parsed.clicks : [] };
  } catch {
    return { links: [], clicks: [] };
  }
}
function writeStore(store) {
  const tempFile = `${dataFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(store, null, 2));
  fs.renameSync(tempFile, dataFile);
}
function findLink(alias) { return readStore().links.find((link) => link.alias === alias); }
function safeLink(row) {
  return { id: row.id, alias: row.alias, url: row.url, createdAt: row.createdAt, expiresAt: row.expiresAt, clicks: row.clicks, passwordProtected: !!row.passwordHash, shortUrl: `${BASE_URL}/${row.alias}` };
}
function validDestination(raw) {
  try {
    const u = new URL(raw);
    return ['http:', 'https:'].includes(u.protocol) && !!u.hostname && !u.username && !u.password;
  } catch { return false; }
}
function page(title, message) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · LinkForge</title><style>body{margin:0;background:#111310;color:#e9ece5;font:15px Arial;display:grid;place-items:center;min-height:100vh}.box{max-width:420px;padding:35px;border:1px solid #343a30;background:#191c17}h1{font-size:23px}p{color:#a2aa9b;line-height:1.6}.mark{color:#c4f45b;font-weight:bold}</style></head><body><main class="box"><div class="mark">LINKFORGE /</div><h1>${title}</h1><p>${message}</p></main></body></html>`;
}
function passwordPage(alias, error = '') {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Protected link · LinkForge</title><style>body{margin:0;background:#111310;color:#e9ece5;font:14px Arial;display:grid;place-items:center;min-height:100vh}.box{width:min(390px,calc(100% - 48px));padding:30px;border:1px solid #343a30;background:#191c17}h1{font-size:22px}.muted{color:#929a8c;line-height:1.5}label{display:block;font-size:10px;color:#929a8c;margin:20px 0 7px}input{box-sizing:border-box;width:100%;padding:12px;background:#111310;border:1px solid #3a4133;color:white}button{margin-top:12px;width:100%;padding:12px;background:#c4f45b;border:0;font-weight:bold;cursor:pointer}.err{color:#ff9b83;font-size:12px}.brand{color:#c4f45b;font-weight:bold;letter-spacing:1px}</style></head><body><form class="box" method="post" action="/${encodeURIComponent(alias)}/unlock"><div class="brand">LINKFORGE /</div><h1>This link is protected.</h1><p class="muted">Enter the password provided by the link owner to continue.</p>${error ? `<p class="err">${error}</p>` : ''}<label for="password">LINK PASSWORD</label><input id="password" name="password" type="password" required minlength="1" autofocus><button type="submit">Continue to destination →</button></form></body></html>`;
}
function redirect(row, req, res) {
  const store = readStore();
  const current = store.links.find((link) => link.id === row.id);
  if (current) current.clicks = (current.clicks || 0) + 1;
  store.clicks.push({ linkId: row.id, clickedAt: new Date().toISOString(), userAgent: String(req.get('user-agent') || '').slice(0, 300) });
  // Keep only the latest 10,000 event records to bound local storage growth.
  if (store.clicks.length > 10000) store.clicks = store.clicks.slice(-10000);
  writeStore(store);
  return res.redirect(302, row.url);
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: FRONTEND_ORIGIN.split(',').map((x) => x.trim()), methods: ['GET', 'POST', 'DELETE', 'OPTIONS'] }));
app.use(express.json({ limit: '30kb' }));
const createLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many links created. Please try again later.' } });

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'LinkForge API' }));
app.get('/api/links', (_req, res) => {
  const links = readStore().links.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
  res.json({ links: links.map(safeLink) });
});
app.post('/api/links', createLimiter, async (req, res) => {
  try {
    const { url, alias, expiresAt, password } = req.body || {};
    if (typeof url !== 'string' || url.length > 2048 || !validDestination(url)) return res.status(400).json({ error: 'Enter a valid http or https destination URL.' });
    if (alias !== undefined && (typeof alias !== 'string' || !/^[a-zA-Z0-9_-]{3,40}$/.test(alias))) return res.status(400).json({ error: 'Aliases must be 3–40 characters using letters, numbers, hyphens or underscores.' });
    let expiry = null;
    if (expiresAt) {
      const date = new Date(expiresAt);
      if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) return res.status(400).json({ error: 'Expiration must be a valid future date.' });
      expiry = date.toISOString();
    }
    if (password !== undefined && (typeof password !== 'string' || password.length < 6 || password.length > 100)) return res.status(400).json({ error: 'A link password must be between 6 and 100 characters.' });
    const store = readStore();
    let finalAlias = alias || nanoid(7);
    if (!alias) { while (store.links.some((link) => link.alias === finalAlias)) finalAlias = nanoid(7); }
    if (store.links.some((link) => link.alias === finalAlias)) return res.status(409).json({ error: 'That alias is already in use. Try another one.' });
    const link = { id: nanoid(12), alias: finalAlias, url, passwordHash: password ? await bcrypt.hash(password, 12) : null, expiresAt: expiry, createdAt: new Date().toISOString(), clicks: 0 };
    store.links.push(link);
    writeStore(store);
    res.status(201).json({ link: safeLink(link) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Unable to create this link.' });
  }
});
app.delete('/api/links/:id', (req, res) => {
  const store = readStore();
  const before = store.links.length;
  store.links = store.links.filter((link) => link.id !== req.params.id);
  if (store.links.length === before) return res.status(404).json({ error: 'Link not found.' });
  store.clicks = store.clicks.filter((click) => click.linkId !== req.params.id);
  writeStore(store);
  res.json({ ok: true });
});
app.get('/:alias', (req, res, next) => {
  if (req.params.alias === 'api' || req.params.alias.includes('.')) return next();
  const row = findLink(req.params.alias);
  if (!row) return res.status(404).send(page('Link not found', 'This LinkForge destination does not exist.'));
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return res.status(410).send(page('Link expired', 'This short link is no longer active.'));
  if (row.passwordHash) return res.status(200).type('html').send(passwordPage(row.alias));
  return redirect(row, req, res);
});
app.post('/:alias/unlock', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
  const row = findLink(req.params.alias);
  if (!row || !row.passwordHash) return res.status(404).send(page('Link unavailable', 'This protected link could not be found.'));
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return res.status(410).send(page('Link expired', 'This short link is no longer active.'));
  const ok = await bcrypt.compare(String(req.body.password || ''), row.passwordHash);
  if (!ok) return res.status(401).type('html').send(passwordPage(row.alias, 'Incorrect password. Please try again.'));
  return redirect(row, req, res);
});
app.use((_req, res) => res.status(404).json({ error: 'Route not found.' }));
app.listen(PORT, () => console.log(`LinkForge API listening on ${BASE_URL}`));
