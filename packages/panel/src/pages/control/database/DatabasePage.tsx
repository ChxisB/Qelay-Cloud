import { useState } from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from '@/lib/usePresence';
import { DatabaseShell } from './DatabaseShell';
import { RowDetailDrawer } from './RowDetailDrawer';
import { useDatabaseController } from './useDatabaseController';

/**
 * Enterprise SQLite inspector. Browsing, schema, filtering and queries run on
 * the control agent over a `readonly` connection — writes are rejected by the
 * engine itself (and by a statement allowlist), so nothing here can mutate the
 * store. Arbitrary queries are time-boxed off-thread so a runaway scan can't
 * freeze the agent.
 */
export function Database() {
  const db = useDatabaseController();
  const { drawerHeld, detail, setDetailSelection } = db;
  const { mounted, leaving } = usePresence(detail !== null && drawerHeld);
  // The last row stays on screen while the drawer leaves.
  const [shown, setShown] = useState(detail);
  if (detail && detail !== shown) setShown(detail);

  return (
    <div>
      <DatabaseShell db={db} />
      {mounted &&
        shown &&
        createPortal(
          <RowDetailDrawer
            table={shown.table}
            columns={shown.columns}
            row={shown.row}
            rowid={shown.rowid}
            truncated={shown.truncated}
            leaving={leaving}
            onClose={() => setDetailSelection(null)}
          />,
          document.body
        )}
    </div>
  );
}
