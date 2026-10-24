// The two payments behind a "cash applied to the wrong invoice?" question, in words:
// which invoice the new payment names, which earlier receipt had already taken it,
// and where that earlier receipt went. Shared by the inbox card and the Why panel.
import { openWhy } from '../app/nav';
import { money } from '../lib/format';
import { useRows } from '../stdb/store';
import { Money } from './ui';

export function MisappliedText({ evidence }: { evidence: Record<string, unknown> }) {
  const receipts = useRows('receipt');
  const applications = useRows('application');
  if (!evidence.invoice) return null;
  const earlierId = String(evidence.earlier ?? '');
  const earlier = receipts.find(r => r.id === earlierId);
  const on = applications.filter(x => x.receiptId === earlierId).sort((x, y) => (x.id < y.id ? -1 : 1));
  // The first placement is the one in question; later rows are the undo and the re-application.
  const by = on.find(x => x.activityId > 0n)?.activityId;
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div>
        Invoice <b style={{ fontWeight: 600 }}>{String(evidence.invoice)}</b> had already been paid by receipt {earlierId}
        {earlier ? (
          <>
            {' '}
            (<Money cents={earlier.amountCents} /> from {earlier.payerName}, reference “{earlier.reference}”)
          </>
        ) : null}
        , whose payer did not name it.
      </div>
      {on.length > 0 && (
        <div className="muted" style={{ fontSize: 13 }}>
          That receipt went to {on.map(x => `${x.invoiceId} (${money(x.amountCents)}${x.reversed ? ', since undone' : ''})`).join(', ')}
          {by !== undefined && (
            <>
              {' '}
              <button className="btn small quiet" onClick={() => openWhy(by)}>
                how the seat placed it
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
