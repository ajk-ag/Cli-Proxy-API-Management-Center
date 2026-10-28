/**
 * Places a provider's plan row (plan, renewal, balances) where the host wants it.
 *
 * Cards leave `container` undefined: the row stays inline at the top of the body.
 * List rows pass the element under the credential name; until that element has
 * mounted they pass null and the row is not drawn, so it never flashes inline.
 */

import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface QuotaPlanSlotProps {
  container?: HTMLElement | null;
  children: ReactNode;
}

export function QuotaPlanSlot({ container, children }: QuotaPlanSlotProps) {
  if (container === undefined) return <>{children}</>;
  return container ? createPortal(children, container) : null;
}
