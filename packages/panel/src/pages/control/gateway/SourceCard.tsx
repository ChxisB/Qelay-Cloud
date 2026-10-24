import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { LinkButton } from '@/components/ui/LinkButton';
import { Tag } from '@/components/ui/Tag';
import type { SourceFull } from '@/lib/bq';
import { stagger } from '@/lib/stagger';
import { graceLine, KIND_WORDS, requestsLink, verificationLine } from './sourceModel';

/**
 * One inbound source: its name, how it checks who posts, and what an operator can do to it. The address and the
 * secret are not here: the server keeps only a hash of each, so they are shown once, when they are made.
 * `arrive` is where the card rises as it mounts (read once).
 */
export function SourceCard({
  source,
  canOperate,
  busy,
  arrive,
  actions,
}: {
  source: SourceFull;
  canOperate: boolean;
  busy: boolean;
  arrive: number | undefined;
  actions: {
    toggle: () => void;
    rotateSecret: () => void;
    rotateAddress: () => void;
    remove: () => void;
  };
}) {
  const [place] = useState(arrive);
  const grace = graceLine(source);
  const toggleWord = source.enabled ? 'Turn off' : 'Turn on';
  return (
    <li
      className={place === undefined ? undefined : 'motion-arrive'}
      style={place === undefined ? undefined : stagger(place)}
    >
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="m-0 flex flex-wrap items-center gap-2 text-sm font-bold text-fg">
              {source.name}
              <Tag>{KIND_WORDS[source.verification.kind]}</Tag>
              {!source.enabled && <Tag>Off</Tag>}
            </p>
            <p className="m-0 mt-1 text-[13px] text-muted">{verificationLine(source)}</p>
            {!source.enabled && (
              <p className="m-0 mt-1 text-[13px] text-muted">
                It is off: its address answers as if it did not exist.
              </p>
            )}
            {grace && <p className="m-0 mt-1 text-[13px] text-muted">{grace}</p>}
            {source.rejectedDropped > 0 && (
              <p className="m-0 mt-1 text-[13px] text-muted">
                {source.rejectedDropped} rejected request{source.rejectedDropped === 1 ? '' : 's'}{' '}
                over the stored limit {source.rejectedDropped === 1 ? 'was' : 'were'} counted but
                not kept.
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <LinkButton
              to={requestsLink(source.id)}
              size="sm"
              aria-label={`Requests of ${source.name}`}
            >
              Requests
            </LinkButton>
            {canOperate && (
              <>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={actions.toggle}
                  aria-label={`${toggleWord} ${source.name}`}
                >
                  {toggleWord}
                </Button>
                {source.signed && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={actions.rotateSecret}
                    aria-label={`New secret for ${source.name}`}
                  >
                    New secret
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={actions.rotateAddress}
                  aria-label={`New address for ${source.name}`}
                >
                  New address
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={actions.remove}
                  aria-label={`Remove ${source.name}`}
                >
                  Remove
                </Button>
              </>
            )}
          </div>
        </div>
      </Card>
    </li>
  );
}
