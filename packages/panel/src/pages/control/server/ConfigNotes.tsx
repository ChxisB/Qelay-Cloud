import { Disclosure } from '@/components/ui/Disclosure';

/** The technical detail behind the Command and Environment variables hints, one click away. */
export function CommandNotes() {
  return (
    <Disclosure summary="More about the command">
      <p className="text-[13px] text-muted">
        The agent passes HTTP_PORT and TCP_PORT to it. QELAY_DATA_PATH is added only when the server
        stores data in SQLite, and removed in the other modes. The default fetches Qelay with bunx;
        for an offline install, point it at a local entry file instead.
      </p>
    </Disclosure>
  );
}

export function EnvNotes() {
  return (
    <Disclosure summary="Variables for finished jobs">
      <ul className="list-disc space-y-2 pl-5 text-[13px] text-muted">
        <li>QELAY_MAX_COMPLETED_JOBS limits how many finished jobs stay in fast memory.</li>
        <li>
          QELAY_COMPLETED_RETENTION_MS makes finished jobs expire after that many milliseconds.
        </li>
        <li>Memory and PostgreSQL modes remove any inherited SQLite path variables.</li>
      </ul>
    </Disclosure>
  );
}
