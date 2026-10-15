import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'fs';

vi.mock('./db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
import { query, withTransaction } from './db.js';
import {
  createToken, deleteToken, findTokenByHash, generateToken, hashToken, invalidateApiTokenSettingsCache,
  listTokens, MAX_TOKENS_PER_USER, tokenStillValid,
} from './apiTokens.js';

// #617: the API token SQL, migration 0067 as it ships included, with expiry decided by the
// database clock. CI does not run this, so apiTokens.test.js pins the expiry expressions too. Uses
// only connection-local temporary tables in an explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('API tokens PostgreSQL', () => {
  let database;
  let migratedSwitch;
  const OWNER = '00000000-0000-4000-8000-000000000001';
  const OTHER = '00000000-0000-4000-8000-000000000002';

  beforeAll(async () => {
    database = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await database.connect();
    // What the migration refers to, as temporary tables, made first so that it reaches nothing else.
    await database.query(`
      CREATE TEMP TABLE users (id uuid PRIMARY KEY, username text NOT NULL);
      CREATE TEMP TABLE system_settings (key varchar(100) PRIMARY KEY, value text, updated_at timestamptz DEFAULT NOW())`);
    const migration = readFileSync(new URL('../../migrations/0067_api_tokens.sql', import.meta.url), 'utf8');
    for (const statement of migration.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) {
      if (!/^(CREATE TABLE IF NOT EXISTS api_tokens |CREATE (UNIQUE )?INDEX IF NOT EXISTS \w+ ON api_tokens\(|INSERT INTO system_settings )/.test(statement)) {
        throw new Error(`0067 has a statement this test cannot keep to temporary tables: ${statement.slice(0, 80)}`);
      }
      await database.query(statement.replace(/^CREATE TABLE/, 'CREATE TEMP TABLE'));
    }
    migratedSwitch = (await database.query("SELECT value FROM system_settings WHERE key = 'api_tokens_enabled'")).rows[0]?.value;
    query.mockImplementation((sql, values) => database.query(sql, values));
    withTransaction.mockImplementation(async (fn) => {
      await database.query('BEGIN');
      try {
        const result = await fn(database);
        await database.query('COMMIT');
        return result;
      } catch (err) {
        await database.query('ROLLBACK');
        throw err;
      }
    });
  });
  afterAll(async () => {
    await database?.end();
  });
  beforeEach(async () => {
    await database.query('TRUNCATE api_tokens, users');
    await database.query("INSERT INTO users VALUES ($1, 'maria'), ($2, 'olga')", [OWNER, OTHER]);
    await database.query("UPDATE system_settings SET value = 'true' WHERE key = 'api_tokens_enabled'");
    invalidateApiTokenSettingsCache();
  });

  // expires: SQL for expires_at, written here, never from input.
  const insertToken = async (userId, expires, name = 'tool') => {
    const secret = generateToken();
    const { rows: [row] } = await database.query(
      `INSERT INTO api_tokens (user_id, name, token_hash, scopes, expires_at)
       VALUES ($1, $2, $3, '["read","organize"]', ${expires}) RETURNING id`,
      [userId, name, hashToken(secret)],
    );
    return { secret, id: row.id };
  };
  const PAST = "NOW() - interval '1 minute'";
  const FUTURE = "NOW() + interval '1 day'";

  it('leaves tokens turned off after the migration', () => {
    expect(migratedSwitch).toBe('false');
  });

  it('looks a token up by its hash, expired once the database clock has reached its expiry', async () => {
    const past = await insertToken(OWNER, PAST);
    const future = await insertToken(OWNER, FUTURE);
    const never = await insertToken(OWNER, 'NULL');
    expect(await findTokenByHash(hashToken(past.secret)))
      .toMatchObject({ id: past.id, user_id: OWNER, username: 'maria', scopes: ['read', 'organize'], expired: true });
    expect(await findTokenByHash(hashToken(future.secret))).toMatchObject({ id: future.id, expired: false });
    expect(await findTokenByHash(hashToken(never.secret))).toMatchObject({ id: never.id, expires_at: null, expired: false });
    expect(await findTokenByHash(hashToken(generateToken()))).toBe(null);
  });

  it('holds a token valid mid-request only while it is unexpired, unrevoked and tokens are on', async () => {
    const past = await insertToken(OWNER, PAST);
    const future = await insertToken(OWNER, FUTURE);
    const never = await insertToken(OWNER, 'NULL');
    expect(await tokenStillValid(past.id)).toBe(false);
    expect(await tokenStillValid(future.id)).toBe(true);
    expect(await tokenStillValid(never.id)).toBe(true);
    await database.query('DELETE FROM api_tokens WHERE id = $1', [future.id]);
    expect(await tokenStillValid(future.id)).toBe(false);
    await database.query("UPDATE system_settings SET value = 'false' WHERE key = 'api_tokens_enabled'");
    invalidateApiTokenSettingsCache();
    expect(await tokenStillValid(never.id)).toBe(false);
  });

  it('lists only the user\'s own tokens, newest first, each marked expired or not', async () => {
    const older = await insertToken(OWNER, PAST, 'older');
    await database.query("UPDATE api_tokens SET created_at = NOW() - interval '1 hour' WHERE id = $1", [older.id]);
    await insertToken(OWNER, 'NULL', 'newer');
    await insertToken(OTHER, 'NULL', 'not hers');
    expect((await listTokens(OWNER)).map(t => [t.name, t.expired])).toEqual([['newer', false], ['older', true]]);
  });

  it('creates a token storing only its hash, and stops at the limit', async () => {
    const created = await createToken(OWNER, { name: 'Claude', scopes: ['read', 'draft'], expiresAt: new Date(Date.now() + 86_400_000) });
    expect(created.apiToken).toMatchObject({ name: 'Claude', scopes: ['read', 'draft'], lastUsedAt: null, expired: false });
    const { rows: [stored] } = await database.query('SELECT token_hash, scopes FROM api_tokens WHERE id = $1', [created.apiToken.id]);
    expect(stored).toEqual({ token_hash: hashToken(created.token), scopes: ['read', 'draft'] });

    for (let i = 1; i < MAX_TOKENS_PER_USER; i++) await insertToken(OWNER, PAST, `t${i}`);
    expect(await createToken(OWNER, { name: 'one too many', scopes: ['read'], expiresAt: null })).toBe(null);
    const { rows: [{ count }] } = await database.query('SELECT COUNT(*)::int AS count FROM api_tokens WHERE user_id = $1', [OWNER]);
    expect(count).toBe(MAX_TOKENS_PER_USER);
    // Another user's limit is their own.
    expect(await createToken(OTHER, { name: 'hers', scopes: ['read'], expiresAt: null })).not.toBe(null);
  });

  it('revokes only the user\'s own token, and a deleted user takes theirs along', async () => {
    const mine = await insertToken(OWNER, 'NULL', 'mine');
    expect(await deleteToken(OTHER, mine.id)).toBe(null);
    expect(await deleteToken(OWNER, mine.id)).toBe('mine');
    expect(await findTokenByHash(hashToken(mine.secret))).toBe(null);
    const hers = await insertToken(OTHER, 'NULL');
    await database.query('DELETE FROM users WHERE id = $1', [OTHER]);
    expect(await findTokenByHash(hashToken(hers.secret))).toBe(null);
  });

  it('keeps one token per hash', async () => {
    const { secret } = await insertToken(OWNER, 'NULL');
    await expect(database.query("INSERT INTO api_tokens (user_id, name, token_hash) VALUES ($1, 'copy', $2)", [OWNER, hashToken(secret)]))
      .rejects.toMatchObject({ code: '23505' });
  });
});
