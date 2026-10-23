// The operator area's sections, in nav order. `path` is relative to /app/ops ('' is the
// overview). A new section is one entry here plus its child route in routes.tsx.
export interface OpsSection {
  path: string;
  label: string;
}

export const OPS_SECTIONS: OpsSection[] = [
  { path: '', label: 'Overview' },
  { path: 'users', label: 'Users' },
];
