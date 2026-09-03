'use strict';
// Storage: the dashboard document, users and invites.
// Postgres when DATABASE_URL is set, otherwise JSON files on disk.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DOC_ID = 'owner';
const newId = () => crypto.randomBytes(8).toString('hex');

/* ------------------------------------------------------------------ file */
function fileStore() {
  const dir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const stateFile = path.join(dir, 'state.json');
  const teamFile = path.join(dir, 'team.json');
  fs.mkdirSync(dir, { recursive: true });
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));

  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  }
  async function writeJson(file, obj) {
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(obj), 'utf8');
    await fsp.rename(tmp, file);
  }
  const team = () => readJson(teamFile, { users: [], invites: [] });
  const withTeam = (fn) => serial(async () => { const t = await team(); const r = await fn(t); await writeJson(teamFile, t); return r; });

  return {
    kind: 'file',
    location: dir,
    async init() {},
    async close() {},

    get: () => serial(async () => {
      const d = await readJson(stateFile, {});
      return { state: d.state ?? null, updatedAt: d.updatedAt ?? null, updatedBy: d.updatedBy ?? null };
    }),
    set: (state, updatedBy) => serial(async () => {
      const updatedAt = new Date().toISOString();
      await writeJson(stateFile, { state, updatedAt, updatedBy });
      return updatedAt;
    }),

    listUsers: () => serial(async () => (await team()).users),
    countUsers: () => serial(async () => (await team()).users.length),
    getUserById: (id) => serial(async () => (await team()).users.find((u) => u.id === id) || null),
    getUserByEmail: (email) => serial(async () => (await team()).users.find((u) => u.email === email) || null),
    createUser: (u) => withTeam((t) => { const user = { id: newId(), createdAt: new Date().toISOString(), ...u }; t.users.push(user); return user; }),
    updateUser: (id, patch) => withTeam((t) => { const u = t.users.find((x) => x.id === id); if (u) Object.assign(u, patch); return u || null; }),
    deleteUser: (id) => withTeam((t) => { t.users = t.users.filter((u) => u.id !== id); }),

    listInvites: () => serial(async () => (await team()).invites.filter((i) => !i.acceptedAt)),
    getInviteByHash: (tokenHash) => serial(async () => (await team()).invites.find((i) => i.tokenHash === tokenHash) || null),
    createInvite: (i) => withTeam((t) => { t.invites = t.invites.filter((x) => x.email !== i.email || x.acceptedAt); const inv = { id: newId(), createdAt: new Date().toISOString(), acceptedAt: null, ...i }; t.invites.push(inv); return inv; }),
    acceptInvite: (id) => withTeam((t) => { const i = t.invites.find((x) => x.id === id); if (i) i.acceptedAt = new Date().toISOString(); }),
    deleteInvite: (id) => withTeam((t) => { t.invites = t.invites.filter((i) => i.id !== id); }),
  };
}

/* -------------------------------------------------------------- postgres */
function pgStore() {
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  const local = /localhost|127\.0\.0\.1/.test(url);
  // TLS with full certificate verification by default (Neon, Supabase, RDS all use public CAs).
  // PGSSL=disable for a local Postgres. PGSSL=no-verify only for a host with a self-signed cert.
  const mode = process.env.PGSSL || (local ? 'disable' : 'verify');
  const ssl = mode === 'disable' ? false : mode === 'no-verify' ? { rejectUnauthorized: false } : { rejectUnauthorized: true };
  const pool = new Pool({ connectionString: url, ssl, max: 5 });
  const q = (text, params) => pool.query(text, params);

  const userRow = (r) => r && ({ id: r.id, email: r.email, name: r.name, role: r.role, passwordHash: r.password_hash, createdAt: r.created_at.toISOString() });
  const inviteRow = (r) => r && ({ id: r.id, email: r.email, role: r.role, tokenHash: r.token_hash, createdBy: r.created_by, expiresAt: r.expires_at.toISOString(), createdAt: r.created_at.toISOString(), acceptedAt: r.accepted_at ? r.accepted_at.toISOString() : null });

  return {
    kind: 'postgres',
    location: url.replace(/:\/\/[^@]*@/, '://***@'),
    async init() {
      await q(`CREATE TABLE IF NOT EXISTS dashboard_state (
        id TEXT PRIMARY KEY, state JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await q(`ALTER TABLE dashboard_state ADD COLUMN IF NOT EXISTS updated_by TEXT`);
      await q(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
        password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await q(`CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
        created_by TEXT, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), accepted_at TIMESTAMPTZ)`);
    },
    close: () => pool.end(),

    async get() {
      const r = await q('SELECT state, updated_at, updated_by FROM dashboard_state WHERE id = $1', [DOC_ID]);
      if (!r.rowCount) return { state: null, updatedAt: null, updatedBy: null };
      return { state: r.rows[0].state, updatedAt: r.rows[0].updated_at.toISOString(), updatedBy: r.rows[0].updated_by };
    },
    async set(state, updatedBy) {
      const r = await q(`INSERT INTO dashboard_state (id, state, updated_at, updated_by) VALUES ($1, $2, now(), $3)
         ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now(), updated_by = EXCLUDED.updated_by
         RETURNING updated_at`, [DOC_ID, JSON.stringify(state), updatedBy || null]);
      return r.rows[0].updated_at.toISOString();
    },

    listUsers: async () => (await q('SELECT * FROM users ORDER BY created_at')).rows.map(userRow),
    countUsers: async () => Number((await q('SELECT count(*) FROM users')).rows[0].count),
    getUserById: async (id) => userRow((await q('SELECT * FROM users WHERE id = $1', [id])).rows[0]) || null,
    getUserByEmail: async (email) => userRow((await q('SELECT * FROM users WHERE email = $1', [email])).rows[0]) || null,
    createUser: async (u) => userRow((await q('INSERT INTO users (id, email, name, role, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING *', [newId(), u.email, u.name, u.role, u.passwordHash])).rows[0]),
    updateUser: async (id, patch) => {
      const sets = []; const vals = []; const map = { name: 'name', role: 'role', passwordHash: 'password_hash' };
      for (const [k, col] of Object.entries(map)) if (patch[k] !== undefined) { vals.push(patch[k]); sets.push(`${col} = $${vals.length}`); }
      if (!sets.length) return this.getUserById(id);
      vals.push(id);
      return userRow((await q(`UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals)).rows[0]) || null;
    },
    deleteUser: async (id) => { await q('DELETE FROM users WHERE id = $1', [id]); },

    listInvites: async () => (await q('SELECT * FROM invites WHERE accepted_at IS NULL ORDER BY created_at')).rows.map(inviteRow),
    getInviteByHash: async (h) => inviteRow((await q('SELECT * FROM invites WHERE token_hash = $1', [h])).rows[0]) || null,
    createInvite: async (i) => {
      await q('DELETE FROM invites WHERE email = $1 AND accepted_at IS NULL', [i.email]);
      return inviteRow((await q('INSERT INTO invites (id, email, role, token_hash, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [newId(), i.email, i.role, i.tokenHash, i.createdBy, i.expiresAt])).rows[0]);
    },
    acceptInvite: async (id) => { await q('UPDATE invites SET accepted_at = now() WHERE id = $1', [id]); },
    deleteInvite: async (id) => { await q('DELETE FROM invites WHERE id = $1', [id]); },
  };
}

function createStore() {
  return process.env.DATABASE_URL ? pgStore() : fileStore();
}

module.exports = { createStore };
