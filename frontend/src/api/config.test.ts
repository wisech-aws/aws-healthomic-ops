import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveApiConfig } from './config';

const COMPLETE_ENV: Record<string, string> = {
  VITE_APPSYNC_ENDPOINT: 'https://example.appsync-api.us-east-1.amazonaws.com/graphql',
  VITE_USER_POOL_ID: 'us-east-1_abc123',
  VITE_USER_POOL_CLIENT_ID: 'client123',
  VITE_AWS_REGION: 'us-east-1',
};

describe('resolveApiConfig', () => {
  it('maps all four Vite env vars onto the config fields', () => {
    const config = resolveApiConfig(COMPLETE_ENV);
    expect(config).toEqual({
      appsyncEndpoint: COMPLETE_ENV.VITE_APPSYNC_ENDPOINT,
      userPoolId: COMPLETE_ENV.VITE_USER_POOL_ID,
      userPoolClientId: COMPLETE_ENV.VITE_USER_POOL_CLIENT_ID,
      region: COMPLETE_ENV.VITE_AWS_REGION,
    });
  });

  it('throws naming a single missing variable', () => {
    const { VITE_USER_POOL_ID: _omitted, ...partial } = COMPLETE_ENV;
    void _omitted;
    expect(() => resolveApiConfig(partial)).toThrow(/VITE_USER_POOL_ID/);
  });

  it('throws listing every missing variable when several are absent', () => {
    expect(() => resolveApiConfig({})).toThrow(
      /VITE_APPSYNC_ENDPOINT.*VITE_USER_POOL_ID.*VITE_USER_POOL_CLIENT_ID.*VITE_AWS_REGION/s,
    );
  });

  it('treats an empty or whitespace-only value as missing', () => {
    const env = { ...COMPLETE_ENV, VITE_AWS_REGION: '   ' };
    expect(() => resolveApiConfig(env)).toThrow(/VITE_AWS_REGION/);
  });

  it('does not report present variables as missing', () => {
    const { VITE_APPSYNC_ENDPOINT: _omitted, ...partial } = COMPLETE_ENV;
    void _omitted;
    expect(() => resolveApiConfig(partial)).not.toThrow(/VITE_USER_POOL_ID/);
  });
});


describe('getApiConfig runtime config (window.__APP_CONFIG__)', () => {
  // getApiConfig caches on first call and reads module-level state, so we reset
  // modules between cases to get a fresh cache.
  afterEach(() => {
    delete (globalThis as unknown as { __APP_CONFIG__?: unknown }).__APP_CONFIG__;
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('prefers window.__APP_CONFIG__ when present', async () => {
    (globalThis as unknown as { __APP_CONFIG__?: unknown }).__APP_CONFIG__ = {
      appsyncEndpoint: 'https://runtime.example/graphql',
      userPoolId: 'us-east-1_rt',
      userPoolClientId: 'rtclient',
      region: 'us-east-1',
    };
    const { getApiConfig: fresh } = await import('./config');
    expect(fresh()).toEqual({
      appsyncEndpoint: 'https://runtime.example/graphql',
      userPoolId: 'us-east-1_rt',
      userPoolClientId: 'rtclient',
      region: 'us-east-1',
    });
  });

  it('falls back to Vite env when __APP_CONFIG__ is an empty placeholder', async () => {
    (globalThis as unknown as { __APP_CONFIG__?: unknown }).__APP_CONFIG__ = {};
    vi.stubEnv('VITE_APPSYNC_ENDPOINT', 'https://env.example/graphql');
    vi.stubEnv('VITE_USER_POOL_ID', 'us-east-1_env');
    vi.stubEnv('VITE_USER_POOL_CLIENT_ID', 'envclient');
    vi.stubEnv('VITE_AWS_REGION', 'us-east-1');
    const { getApiConfig: fresh } = await import('./config');
    expect(fresh().appsyncEndpoint).toBe('https://env.example/graphql');
  });
});
