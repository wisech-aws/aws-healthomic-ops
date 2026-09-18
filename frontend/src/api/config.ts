/**
 * Build-time API configuration.
 *
 * All values originate from CDK stack outputs (AppSync endpoint, Cognito user
 * pool ID, app client ID, region) and are injected into the Vite build through
 * `VITE_*` environment variables. The SPA carries NO hardcoded environment
 * values (Req 11.7); if a required variable is missing the app fails fast with
 * a clear, actionable error rather than silently pointing at nothing.
 *
 * The build step that produces the `VITE_*` variables from CDK outputs lives in
 * `scripts/inject-config.mjs`.
 */

/** The resolved, validated API configuration. */
export interface ApiConfig {
  /** AppSync GraphQL endpoint URL. */
  readonly appsyncEndpoint: string;
  /** Cognito user pool ID. */
  readonly userPoolId: string;
  /** Cognito app client ID for the SPA. */
  readonly userPoolClientId: string;
  /** AWS region the API is deployed in. */
  readonly region: string;
}

/** Maps each config field to the Vite env var it is injected through. */
const ENV_VAR_BY_FIELD: Readonly<Record<keyof ApiConfig, string>> = {
  appsyncEndpoint: 'VITE_APPSYNC_ENDPOINT',
  userPoolId: 'VITE_USER_POOL_ID',
  userPoolClientId: 'VITE_USER_POOL_CLIENT_ID',
  region: 'VITE_AWS_REGION',
};

/**
 * Reads and validates the API configuration from a Vite-style env record.
 *
 * Exported (rather than reading `import.meta.env` inline) so it is directly
 * unit-testable without a live Vite build. Throws a single error listing every
 * missing variable so a misconfigured build is diagnosed in one pass.
 *
 * @param env The `import.meta.env`-shaped record to read from.
 */
export function resolveApiConfig(
  env: Record<string, string | undefined>,
): ApiConfig {
  const missing: string[] = [];
  const read = (field: keyof ApiConfig): string => {
    const varName = ENV_VAR_BY_FIELD[field];
    const value = env[varName];
    if (value === undefined || value.trim() === '') {
      missing.push(varName);
      return '';
    }
    return value;
  };

  const config: ApiConfig = {
    appsyncEndpoint: read('appsyncEndpoint'),
    userPoolId: read('userPoolId'),
    userPoolClientId: read('userPoolClientId'),
    region: read('region'),
  };

  if (missing.length > 0) {
    throw new Error(
      `Missing required API configuration environment variable(s): ` +
        `${missing.join(', ')}. These are injected at build time from the CDK ` +
        `stack outputs (see scripts/inject-config.mjs). The SPA carries no ` +
        `hardcoded environment values.`,
    );
  }

  return config;
}

/**
 * Shape of the runtime config object a deployed build reads from
 * `window.__APP_CONFIG__`. It is written at DEPLOY time by the CDK
 * FrontendStack (from the ApiStack outputs) into a `config.js` served alongside
 * the SPA, so the same pre-built bundle can be deployed against any backend
 * without a rebuild. Local dev / mock mode has no such object and falls back to
 * Vite `import.meta.env`.
 */
export interface RuntimeAppConfig {
  appsyncEndpoint?: string;
  userPoolId?: string;
  userPoolClientId?: string;
  region?: string;
}

declare global {
  interface Window {
    __APP_CONFIG__?: RuntimeAppConfig;
  }
}

/**
 * Read the deploy-time runtime config from `window.__APP_CONFIG__` as a
 * Vite-env-shaped record (so it flows through {@link resolveApiConfig}), or
 * `null` when absent (local dev / tests / mock mode).
 */
function readRuntimeConfigAsEnv(): Record<string, string | undefined> | null {
  const rc =
    typeof window !== 'undefined' ? window.__APP_CONFIG__ : undefined;
  if (
    rc == null ||
    // Treat an empty/placeholder object as absent.
    (rc.appsyncEndpoint == null &&
      rc.userPoolId == null &&
      rc.userPoolClientId == null &&
      rc.region == null)
  ) {
    return null;
  }
  return {
    VITE_APPSYNC_ENDPOINT: rc.appsyncEndpoint,
    VITE_USER_POOL_ID: rc.userPoolId,
    VITE_USER_POOL_CLIENT_ID: rc.userPoolClientId,
    VITE_AWS_REGION: rc.region,
  };
}

/**
 * The API configuration for this build.
 *
 * Resolution order (first non-empty wins):
 *   1. Deploy-time runtime config on `window.__APP_CONFIG__` (production; written
 *      by CDK so the pre-built bundle needs no rebuild per environment).
 *   2. Vite `import.meta.env` (`VITE_*`) for local dev / build-time injection.
 * Evaluated lazily via {@link getApiConfig} so importing modules (and tests) do
 * not fail at import time in an unconfigured environment.
 */
let cachedConfig: ApiConfig | undefined;

/** Returns the resolved API config on first call, from runtime config or env. */
export function getApiConfig(): ApiConfig {
  if (cachedConfig === undefined) {
    const runtime = readRuntimeConfigAsEnv();
    cachedConfig = resolveApiConfig(
      runtime ??
        (import.meta.env as unknown as Record<string, string | undefined>),
    );
  }
  return cachedConfig;
}

/**
 * Whether the app is running in LOCAL MOCK mode.
 *
 * Local mock mode is for browsing the UI on a developer machine without a
 * deployed backend or a signed-in Cognito user. When `VITE_LOCAL_MOCK` is
 * `'true'`, the GraphQL client short-circuits to in-memory sample data and
 * no-op subscriptions instead of calling AppSync — so there is no auth flow and
 * no "No federated jwt" error (Amplify is never configured or invoked).
 *
 * It is driven by an explicit build-time flag (set by `scripts/dev-local.sh`)
 * rather than inferred from placeholder config, so a real deployment never
 * silently falls into mock mode.
 */
export function isLocalMockMode(
  env: Record<string, string | undefined> = import.meta.env as unknown as Record<
    string,
    string | undefined
  >,
): boolean {
  return env.VITE_LOCAL_MOCK === 'true';
}


/**
 * Configures Amplify (Auth + GraphQL API) from the injected build-time config.
 *
 * Both the sign-in UI (`@aws-amplify/ui-react` Authenticator, wired in
 * `main.tsx`) and the GraphQL client depend on Amplify being configured, so
 * this lives in one shared, idempotent place. Safe to call more than once; only
 * the first call performs configuration.
 *
 * In local mock mode this is a no-op: the client short-circuits to sample data
 * and never touches Amplify, so there is nothing to configure (and no Cognito
 * sign-in is required).
 */
let amplifyConfigured = false;
export async function configureAmplify(): Promise<void> {
  if (amplifyConfigured || isLocalMockMode()) {
    return;
  }
  const config = getApiConfig();
  // Import lazily so mock-mode/test paths that never authenticate don't pull in
  // the Amplify runtime.
  const { Amplify } = await import('aws-amplify');
  Amplify.configure({
    API: {
      GraphQL: {
        endpoint: config.appsyncEndpoint,
        region: config.region,
        defaultAuthMode: 'userPool',
      },
    },
    Auth: {
      Cognito: {
        userPoolId: config.userPoolId,
        userPoolClientId: config.userPoolClientId,
      },
    },
  });
  amplifyConfigured = true;
}
