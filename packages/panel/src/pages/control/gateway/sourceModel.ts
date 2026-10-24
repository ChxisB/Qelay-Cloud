import type { StateRole } from '@/components/ui/StatusBadge';
import type {
  AddSourceBody,
  RequestStatus,
  SourceFull,
  SourceIssued,
  SourceVerificationKind,
} from '@/lib/bq';
import { formatDateTime } from '@/lib/format';
import { NAME_MAX } from './connectionPatch';

/** The Sources screen and the Requests screen: the words for a source, and the add form's checks. */

export const SOURCES = '/events-gateway/sources';
export const REQUESTS = '/events-gateway/requests';

/** The requests of one source, or of all of them. */
export const requestsLink = (sourceId?: string): string =>
  sourceId ? `${REQUESTS}?source=${encodeURIComponent(sourceId)}` : REQUESTS;

/** The path a sender posts to. The ingest's own address goes in front of it; the Control API does not know that. */
export const ingestPath = (token: string): string => `/s/${token}`;

/** What a create or a rotation made, shown once: the path to post to and the secret. Kept in page state only. */
export interface Issued {
  name: string;
  /** `/s/<token>`; null when only the secret was made. */
  path: string | null;
  secret: string | null;
}

export const issuedOf = ({ source, token, secret }: SourceIssued): Issued => ({
  name: source.name,
  path: token === null ? null : ingestPath(token),
  secret,
});

export const KIND_WORDS: Record<SourceVerificationKind, string> = {
  none: 'No check',
  hmac: 'Signature',
  basic: 'Basic login',
  api_key: 'API key',
};

/** How a source checks who posts, in a sentence. The secret is never shown, so it only says whether there is one. */
export function verificationLine(source: SourceFull): string {
  const { kind, header, username } = source.verification;
  if (kind === 'none')
    return 'Anyone who has the address can send. Add a check if it is not secret.';
  if (kind === 'hmac')
    return `Each request must carry a signature of its body in the ${header} header.`;
  if (kind === 'api_key') return `Each request must carry the key in the ${header} header.`;
  return `Each request must log in as ${username} with the secret as the password.`;
}

export interface SourceFields {
  name: string;
  kind: SourceVerificationKind;
  header: string;
  username: string;
  secret: string;
}

export type SourceField = keyof SourceFields;

/** What a header or user name is offered as when the check is chosen. */
export const DEFAULT_HEADER: Record<SourceVerificationKind, string> = {
  none: '',
  hmac: 'x-signature',
  api_key: 'x-api-key',
  basic: '',
};

export const blankSource = (): SourceFields => ({
  name: '',
  kind: 'none',
  header: '',
  username: '',
  secret: '',
});

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/u;
const SECRET_MIN = 16;
const SECRET_MAX = 256;

export type SourceBodyResult =
  | { ok: true; body: AddSourceBody }
  | { ok: false; field: SourceField; msg: string };

/** The body to send, or the field to blame. The server checks again; this only saves a round trip. */
export function sourceBodyOf(fields: SourceFields): SourceBodyResult {
  const name = fields.name.trim();
  const { kind } = fields;
  const fail = (field: SourceField, msg: string): SourceBodyResult => ({ ok: false, field, msg });
  if (name === '') return fail('name', 'Give the source a name.');
  if (name.length > NAME_MAX) return fail('name', `A name is at most ${NAME_MAX} characters.`);
  const secret = fields.secret.trim();
  if (
    kind !== 'none' &&
    secret !== '' &&
    (secret.length < SECRET_MIN || secret.length > SECRET_MAX)
  ) {
    return fail(
      'secret',
      `A secret is ${SECRET_MIN} to ${SECRET_MAX} characters, or leave it blank.`
    );
  }
  if (kind === 'none') return { ok: true, body: { name } };
  const withSecret = secret === '' ? {} : { secret };
  if (kind === 'basic') {
    const username = fields.username.trim();
    if (username === '' || username.includes(':')) {
      return fail('username', 'A user name has no colon and is not blank.');
    }
    return { ok: true, body: { name, verification: { kind, username }, ...withSecret } };
  }
  const header = fields.header.trim();
  if (!HEADER_NAME.test(header)) {
    return fail('header', 'A header name is letters, digits and dashes, up to 64 characters.');
  }
  return { ok: true, body: { name, verification: { kind, header }, ...withSecret } };
}

/** "Old secret works until 14:02 on 12 Mar" while a rotated-out secret still verifies. */
export const graceLine = (source: SourceFull): string | null =>
  source.previousSecretUntil !== null && source.previousSecretUntil > Date.now()
    ? `The old secret also works until ${formatDateTime(source.previousSecretUntil)}.`
    : null;

export const REQUEST_WORDS: Record<RequestStatus, string> = {
  accepted: 'Accepted',
  rejected: 'Rejected',
};
export const REQUEST_ROLE: Record<RequestStatus, StateRole> = {
  accepted: 'completed',
  rejected: 'failed',
};

/** The Requests screen's status chips. */
export const REQUEST_CHIPS: ReadonlyArray<{ value: RequestStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'accepted', label: REQUEST_WORDS.accepted },
  { value: 'rejected', label: REQUEST_WORDS.rejected },
];

/** "2.3 KB", for the size of a stored body; null when none was kept. */
export function bytesLine(bytes: number | null): string {
  if (bytes === null) return 'no body';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
}
