import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/form';
import { MAX_NAME, MAX_VIEWS, type SavedView, useSavedViews } from './useSavedViews';

export type ViewFilters = Pick<SavedView, 'route' | 'status' | 'range'>;

/**
 * Pick a saved filter set, or name the one on screen and keep it. When the filters on screen are a
 * saved view, it is the chosen one and can be deleted; otherwise there is a name to give it.
 */
export function SavedViews({
  current,
  onApply,
}: {
  current: ViewFilters;
  onApply: (view: ViewFilters) => void;
}) {
  const { views, blocked, save, remove } = useSavedViews();
  const [name, setName] = useState('');
  const chosen = views.find(
    (view) =>
      view.route === current.route && view.status === current.status && view.range === current.range
  );
  const full = views.length >= MAX_VIEWS;
  const note = blocked
    ? 'This browser blocks storage, so views cannot be saved.'
    : full && !chosen
      ? `${MAX_VIEWS} views are saved. Delete one to save another.`
      : null;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Saved views"
          className="w-auto!"
          value={chosen?.name ?? ''}
          onChange={(event) => {
            const picked = views.find((view) => view.name === event.target.value);
            if (picked) onApply(picked);
          }}
        >
          <option value="">Saved views</option>
          {views.map((view) => (
            <option key={view.name} value={view.name}>
              {view.name}
            </option>
          ))}
        </Select>
        {chosen ? (
          <Button size="sm" onClick={() => remove(chosen.name)}>
            Delete view
          </Button>
        ) : (
          <>
            <Input
              aria-label="View name"
              className="w-40!"
              value={name}
              onInput={(event) => setName(event.currentTarget.value)}
              maxLength={MAX_NAME}
              placeholder="Name this view"
            />
            <Button
              size="sm"
              disabled={blocked || full || name.trim() === ''}
              onClick={() => {
                save({ ...current, name });
                setName('');
              }}
            >
              Save view
            </Button>
          </>
        )}
      </div>
      {note && <p className="m-0 text-xs text-muted">{note}</p>}
    </div>
  );
}
