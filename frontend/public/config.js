/*
 * Runtime app configuration placeholder.
 *
 * In a deployed environment, CDK's FrontendStack OVERWRITES this file in S3
 * with the real ApiStack values, setting window.__APP_CONFIG__ so the pre-built
 * SPA points at the correct backend without a rebuild.
 *
 * This checked-in placeholder is intentionally empty: local dev (`vite`) and
 * mock mode fall back to Vite `import.meta.env` when __APP_CONFIG__ is empty.
 */
window.__APP_CONFIG__ = {};
