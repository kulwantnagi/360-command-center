'use strict';
// Loads .env if present (Node 20.12+). Production hosts usually inject env vars directly.
try { process.loadEnvFile(); } catch { /* no .env file, that is fine */ }

const path = require('path');
const express = require('express');
const { createStore } = require('./lib/store');
const auth = require('./lib/auth');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const INVITE_DAYS = 7;
const store = createStore();
const app = express();
const requireAuth = auth.makeRequireAuth(store);

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt });
const wantsJson = (req) => (req.headers.accept || '').includes('application/json');
const baseUrl = (req) => (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ================= public routes ================= */
app.get('/healthz', (req, res) => res.json({ ok: true, store: store.kind }));

app.get('/login', (req, res) => {
  if (auth.readSession(req)) return res.redirect('/');
  res.sendFile(path.join(PUBLIC, 'login.html'));
});

app.post('/login', auth.loginLimiter, wrap(async (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const user = email ? await store.getUserByEmail(email) : null;
  if (user && auth.verifyPassword(req.body.password, user.passwordHash)) {
    auth.setSession(req, res, user.id);
    return wantsJson(req) ? res.json({ ok: true }) : res.redirect('/');
  }
  return wantsJson(req) ? res.status(401).json({ error: 'Wrong email or password' }) : res.redirect('/login?error=1');
}));

app.post('/logout', (req, res) => { auth.clearSession(res); res.redirect('/login'); });

// Invite acceptance: the page, the lookup, and the account creation.
app.get('/invite/:token', (req, res) => res.sendFile(path.join(PUBLIC, 'invite.html')));

async function findLiveInvite(token) {
  const inv = await store.getInviteByHash(auth.hashToken(token));
  if (!inv || inv.acceptedAt) return { error: 'This invite link was already used or removed.' };
  if (new Date(inv.expiresAt) < new Date()) return { error: 'This invite link has expired. Ask for a new one.' };
  return { inv };
}

app.get('/api/invite/:token', wrap(async (req, res) => {
  const { inv, error } = await findLiveInvite(req.params.token);
  if (error) return res.status(410).json({ error });
  const inviter = inv.createdBy ? await store.getUserById(inv.createdBy) : null;
  res.json({ email: inv.email, role: inv.role, invitedBy: inviter ? inviter.name : null });
}));

app.post('/api/invite/:token', auth.loginLimiter, wrap(async (req, res) => {
  const { inv, error } = await findLiveInvite(req.params.token);
  if (error) return res.status(410).json({ error });
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Tell us your name' });
  const pwProblem = auth.passwordProblem(req.body.password);
  if (pwProblem) return res.status(400).json({ error: pwProblem });
  if (await store.getUserByEmail(inv.email)) return res.status(409).json({ error: 'This email already has an account. Sign in instead.' });
  const user = await store.createUser({ email: inv.email, name, role: inv.role, passwordHash: auth.hashPassword(req.body.password) });
  await store.acceptInvite(inv.id);
  auth.setSession(req, res, user.id);
  res.json({ ok: true, user: publicUser(user) });
}));

/* ================= signed-in routes ================= */
app.use(requireAuth);

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
app.get('/api/me', (req, res) => res.json(publicUser(req.user)));

app.post('/api/account/password', wrap(async (req, res) => {
  if (!auth.verifyPassword(req.body.current, req.user.passwordHash)) return res.status(400).json({ error: 'Current password is wrong' });
  const problem = auth.passwordProblem(req.body.next);
  if (problem) return res.status(400).json({ error: problem });
  await store.updateUser(req.user.id, { passwordHash: auth.hashPassword(req.body.next) });
  res.json({ ok: true });
}));

/* ---------- dashboard state ---------- */
app.get('/api/state', wrap(async (req, res) => res.json(await store.get())));

const validState = (s) => s && typeof s === 'object' && s.settings && Array.isArray(s.posts) && Array.isArray(s.ideas);
const saveState = wrap(async (req, res) => {
  const { state, base } = req.body || {};
  if (!validState(state)) return res.status(400).json({ error: 'That does not look like a dashboard state' });
  const current = await store.get();
  // Another device saved after this one loaded: hand back the newer copy instead of overwriting it.
  if (current.updatedAt && base !== current.updatedAt) {
    return res.status(409).json({ conflict: true, state: current.state, updatedAt: current.updatedAt, updatedBy: current.updatedBy });
  }
  const updatedAt = await store.set(state, req.user.name);
  res.json({ ok: true, updatedAt });
});
app.put('/api/state', auth.requireRole('owner', 'editor'), saveState);
app.post('/api/state', auth.requireRole('owner', 'editor'), saveState); // sendBeacon on tab close

/* ---------- team (owner only) ---------- */
const ownerOnly = auth.requireRole('owner');

app.get('/api/team', ownerOnly, wrap(async (req, res) => {
  const [users, invites, doc] = await Promise.all([store.listUsers(), store.listInvites(), store.get()]);
  res.json({
    users: users.map(publicUser),
    invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt, createdAt: i.createdAt })),
    lastSave: { at: doc.updatedAt, by: doc.updatedBy },
  });
}));

app.post('/api/team/invites', ownerOnly, wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const role = req.body.role;
  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (!['editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'Role must be editor or viewer' });
  if (await store.getUserByEmail(email)) return res.status(409).json({ error: 'That email already has an account' });
  const token = auth.newInviteToken();
  const inv = await store.createInvite({
    email, role, tokenHash: auth.hashToken(token), createdBy: req.user.id,
    expiresAt: new Date(Date.now() + INVITE_DAYS * 86400000).toISOString(),
  });
  res.json({ ok: true, id: inv.id, email, role, expiresAt: inv.expiresAt, link: `${baseUrl(req)}/invite/${token}` });
}));

app.delete('/api/team/invites/:id', ownerOnly, wrap(async (req, res) => { await store.deleteInvite(req.params.id); res.json({ ok: true }); }));

app.patch('/api/team/users/:id', ownerOnly, wrap(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role' });
  const role = req.body.role;
  if (!['editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'Role must be editor or viewer' });
  const u = await store.updateUser(req.params.id, { role });
  if (!u) return res.status(404).json({ error: 'No such member' });
  res.json({ ok: true, user: publicUser(u) });
}));

app.delete('/api/team/users/:id', ownerOnly, wrap(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot remove yourself' });
  const u = await store.getUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'No such member' });
  if (u.role === 'owner') return res.status(400).json({ error: 'The owner cannot be removed' });
  await store.deleteUser(u.id);
  res.json({ ok: true });
}));

app.use(express.static(PUBLIC, { index: false, maxAge: '1h' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Server error. Check the server logs.' });
  res.status(500).send('Server error. Check the server logs.');
});

/* ================= start ================= */
async function ensureOwner() {
  if (await store.countUsers()) return;
  const email = normEmail(process.env.OWNER_EMAIL) || 'owner@dashboard.local';
  const password = process.env.DASHBOARD_PASSWORD;
  const problem = auth.passwordProblem(password);
  if (problem) throw new Error(`No accounts exist yet, so DASHBOARD_PASSWORD is needed to create the owner. ${problem}.`);
  await store.createUser({ email, name: process.env.OWNER_NAME || 'Owner', role: 'owner', passwordHash: auth.hashPassword(password) });
  console.log(`Owner account created: ${email}. Sign in with DASHBOARD_PASSWORD, then change it under Team → Your account.`);
}

store.init()
  .then(ensureOwner)
  .then(() => app.listen(PORT, () => {
    console.log(`360° Command Center running on http://localhost:${PORT}`);
    console.log(`Storage: ${store.kind} (${store.location})`);
  }))
  .catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => store.close().finally(() => process.exit(0)));
