// Who runs Panote, for the legal pages. Undecided values stay `YOUR_…` placeholders:
// they show as-is on dev, and the production deploy refuses to run while any file under
// src/legal/ still has one (.github/workflows/deploy.yml; TODO in docs/deploy.md).
export const OPERATOR_NAME = 'YOUR_OPERATOR_LEGAL_NAME';
export const OPERATOR_ADDRESS = 'YOUR_OPERATOR_POSTAL_ADDRESS';
/** The courts a counter-notice consents to, e.g. "England and Wales". */
export const OPERATOR_JURISDICTION = 'YOUR_GOVERNING_LAW_JURISDICTION';
