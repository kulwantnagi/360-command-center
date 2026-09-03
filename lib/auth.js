'use strict';
// Accounts: scrypt password hashes, HMAC-signed session cookies, role checks.
const crypto = require('crypto');

const ROLES = ['owner', 'editor', 'viewer'];
const COOKIE = 'kn360_session';
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET is not set. A random one was generated, so everyone is signed out when the server restarts.');
}

/* ---------- passwords ---------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(password, salt, 64).toString('base64url');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'base64url');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters';
  if (pw.length > 200) return 'Password is too long';
  return null;
}

/* ---------- sessions ---------- */
const hmac = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${data}.${hmac(data)}`;
}
function verify(token) {
  if (typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const data = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = hmac(data);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.uid || !payload.exp || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch { return null; }
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}
const isSecure = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';
const readSession = (req) => verify(parseCookies(req)[COOKIE]);

function setSession(req, res, userId) {
  const token = sign({ uid: userId, exp: Math.floor(Date.now() / 1000) + TTL_SECONDS });
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${TTL_SECONDS}`];
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/* ---------- middleware ---------- */
function makeRequireAuth(store) {
  return async function requireAuth(req, res, next) {
    const deny = () => {
      clearSession(res);
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in first' });
      res.redirect('/login');
    };
    try {
      const s = readSession(req);
      if (!s) return deny();
      const user = await store.getUserById(s.uid);
      if (!user) return deny();
      req.user = user;
      next();
    } catch (e) { next(e); }
  };
}
const requireRole = (...roles) => (req, res, next) => {
  if (req.user && roles.includes(req.user.role)) return next();
  res.status(403).json({ error: 'Your role does not allow that' });
};

// Slow down password guessing: 8 attempts per IP per 15 minutes.
const attempts = new Map();
function loginLimiter(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let rec = attempts.get(ip);
  if (!rec || rec.reset < now) { rec = { count: 0, reset: now + 15 * 60 * 1000 }; attempts.set(ip, rec); }
  if (rec.count >= 8) return res.status(429).send('Too many attempts. Wait 15 minutes and try again.');
  rec.count += 1;
  next();
}

/* ---------- invites ---------- */
const newInviteToken = () => crypto.randomBytes(24).toString('base64url');
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

module.exports = { ROLES, hashPassword, verifyPassword, passwordProblem, readSession, setSession, clearSession, makeRequireAuth, requireRole, loginLimiter, newInviteToken, hashToken };
