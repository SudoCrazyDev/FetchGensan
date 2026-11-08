'use client';

import { humanizeError } from '@fetch/api';
import type { DriverRosterRow } from '@fetch/api';
import { useAdminTopup } from '@fetch/api/admin';
import { formatPeso, pesos } from '@fetch/core';

import { PromptDialog } from './ui';

/** Records cash a rider handed over at the office. */
export function TopupDialog({
  driver,
  onClose,
}: {
  driver: Pick<DriverRosterRow, 'id' | 'full_name' | 'wallet_balance_centavos'> | null;
  onClose: () => void;
}) {
  const topup = useAdminTopup();
  const owed = driver ? Math.abs(Math.min(0, driver.wallet_balance_centavos)) : 0;

  return (
    <PromptDialog
      open={driver !== null}
      title={`Cash top-up from ${driver?.full_name || 'rider'}`}
      description={
        owed > 0
          ? `They currently owe ${formatPeso(owed)}.`
          : 'They do not owe anything; this becomes credit against future commission.'
      }
      label="Amount received (₱)"
      inputMode="decimal"
      initialValue={owed > 0 ? String(Math.ceil(owed / 100)) : ''}
      confirmLabel="Record top-up"
      required
      busy={topup.isPending}
      error={topup.error ? humanizeError(topup.error) : null}
      onCancel={onClose}
      onConfirm={(value) => {
        const amount = Number(value);
        if (!driver || !Number.isFinite(amount) || amount <= 0) return;
        topup.mutate(
          {
            driverId: driver.id,
            amountCentavos: pesos(amount),
            note: 'Cash top-up at dispatch office',
          },
          { onSuccess: onClose },
        );
      }}
    />
  );
}
