// Auto-rotate is motion the visitor didn't start, so it starts off for those who opt out.
export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
