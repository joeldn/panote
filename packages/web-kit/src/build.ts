// Node-safe entry for the apps' vite.config.ts: no SDK, viewer or DOM imports.
export { ConfigError, loadConfig, type AppConfig } from './config.js';
export { buildHeadersFile, contentSecurityPolicy, type HeadersFileOptions } from './headers.js';
