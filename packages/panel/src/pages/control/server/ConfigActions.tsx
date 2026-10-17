import { Button } from '@/components/ui/Button';
import { IconRefresh } from '@/components/ui/icons';

/**
 * The Configuration form's footer: save, save & restart, and the one status line that explains
 * the state of the edit (pending restart, saved, conflict, error). Must render inside the form —
 * "Save config" is its submit button.
 */
export function ConfigActions({
  busy,
  running,
  pending,
  saved,
  conflict,
  error,
  onSaveAndRestart,
  onReload,
}: {
  busy: boolean;
  running: boolean;
  /** The server is running with a config that differs from the one being edited. */
  pending: boolean;
  saved: boolean;
  conflict: boolean;
  error: string | null;
  onSaveAndRestart: () => void;
  onReload: () => void;
}) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line pt-4">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 basis-40">
        {pending && !saved && (
          <span className="text-xs text-warning">Restart to apply changes</span>
        )}
        {saved && <span className="text-xs text-success">Saved</span>}
        {conflict && (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onReload}>
            Reload latest
          </Button>
        )}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2.5">
        {/* One orange action: Save & restart while the server runs, else Save config. */}
        <Button type="submit" variant={running ? 'default' : 'primary'} size="sm" disabled={busy}>
          Save config
        </Button>
        {running && (
          <Button variant="primary" size="sm" disabled={busy} onClick={onSaveAndRestart}>
            <IconRefresh className="size-3.5" /> Save & restart
          </Button>
        )}
      </div>
    </div>
  );
}
