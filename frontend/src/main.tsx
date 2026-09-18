import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Cloudscape global styles: applies the design system's reset, typography, and
// design tokens to the whole document. Must be imported once at the app root.
import '@cloudscape-design/global-styles/index.css';
import { applyMode, Mode } from '@cloudscape-design/global-styles';
// Amplify UI Authenticator styles (sign-in form). Loaded once at the root.
import '@aws-amplify/ui-react/styles.css';
import { configureAmplify } from './api/config';
import App from './App';

// Default to the light visual mode; Cloudscape also supports dark mode via
// applyMode(Mode.Dark). Kept light for the dashboard's default appearance.
applyMode(Mode.Light);

// Configure Amplify (Auth + GraphQL) up front so the sign-in UI and the GraphQL
// client share one configuration. No-op in local mock mode.
void configureAmplify();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
