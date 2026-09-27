import { useId } from 'react';

/** Stable id for wiring `ModalHeader` to `Modal.labelledBy`. */
export const useModalTitleId = (): string => `pn-modal-${useId()}`;
