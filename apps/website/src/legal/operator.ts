// Who runs Panote, for the legal pages. Undecided values stay `YOUR_…` placeholders:
// they show as-is on dev, and the production deploy refuses to run while any file under
// src/legal/ still has one (.github/workflows/deploy.yml; TODO in docs/deploy.md).
export const OPERATOR_NAME = 'YOUR_OPERATOR_LEGAL_NAME';
export const OPERATOR_ADDRESS = 'YOUR_OPERATOR_POSTAL_ADDRESS';
/** The law that governs the terms, and whose courts hear disputes, e.g. "England and Wales". */
export const OPERATOR_JURISDICTION = 'YOUR_GOVERNING_LAW_JURISDICTION';
/** Total liability under the terms, e.g. "£100". */
export const OPERATOR_LIABILITY_CAP = 'YOUR_LIABILITY_CAP';
/**
 * The EU and UK representatives (GDPR and UK GDPR Art. 27), e.g. "in the EU, Example Rep
 * GmbH, Berlin; in the UK, Example Rep Ltd, London". Set it to '' if the operator is based in
 * both, and the sentence is dropped.
 */
export const OPERATOR_REPRESENTATIVES: string = 'YOUR_EU_AND_UK_REPRESENTATIVES';
/** The copyright agent registered with the US Copyright Office (17 USC 512(c)(2)). */
export const DMCA_AGENT_NAME = 'YOUR_DMCA_AGENT_NAME';
export const DMCA_AGENT_ADDRESS = 'YOUR_DMCA_AGENT_POSTAL_ADDRESS';
export const DMCA_AGENT_PHONE = 'YOUR_DMCA_AGENT_PHONE';
