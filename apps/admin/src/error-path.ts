// Error reports carry the route, not the tour: /app/t/<tourId>/... becomes
// /app/t/:tourId/... (packages/web-kit error-reporter).
export const redactAdminPath = (pathname: string): string =>
  pathname.replace(/^\/app\/t\/[^/]+/, '/app/t/:tourId');
