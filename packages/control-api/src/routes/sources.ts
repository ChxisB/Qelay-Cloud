import { ApiError } from '../errors';
import type { Route } from '../http/router';
import type { JobsContext } from '../jobs/context';
import {
  sourceBody,
  sourcePatchBody,
  sourceRotateBody,
  toIssuedSourceWire,
  toSourceWire,
} from '../jobs/sourceModel';

const notFound = (id: string): ApiError =>
  new ApiError(404, 'source_not_found', 'source not found', { sourceId: id });

/**
 * Inbound sources (DESIGN.md D12): `POST /sources` registers one and answers once with the URL token and, for a source that
 * verifies, the secret (the one given, or one the store made). Neither is read back by any call, logged or audited: the
 * audit entry has the source's id. `rotate-token` gives a leaked URL a new token (the old one stops at once) and
 * `rotate-secret` a new secret (the old one verifies for a day more). Verification is fixed once made. `DELETE` is a 409
 * `source_in_use` while a route listens to the source. A source that is off answers its URL with a 404, as one that does not exist.
 */
export function sourceRoutes(ctx: JobsContext): Route[] {
  const { store } = ctx;

  return [
    {
      method: 'GET',
      path: '/sources',
      access: 'read',
      async handle() {
        return { ok: true, data: { sources: (await store.sources.list()).map(toSourceWire) } };
      },
    },
    {
      method: 'POST',
      path: '/sources',
      access: 'write',
      async handle(context) {
        const body = await context.json(sourceBody);
        const { verification } = body;
        const source = await store.sources.create(
          {
            name: body.name,
            ...(verification === undefined
              ? {}
              : {
                  verification: {
                    kind: verification.kind,
                    ...(verification.header == null ? {} : { header: verification.header }),
                    ...(verification.username == null ? {} : { username: verification.username }),
                  },
                }),
            ...(body.secret == null ? {} : { secret: body.secret }),
            ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
          },
          context.principal!.subject
        );
        // The entry was written before this ran, so it could not know the id.
        context.audit(`source=${source.id}`);
        return Response.json({ ok: true, data: toIssuedSourceWire(source) }, { status: 201 });
      },
    },
    {
      method: 'GET',
      path: '/sources/:id',
      access: 'read',
      async handle({ params }) {
        const source = await store.sources.get(params.id!);
        if (source === null) throw notFound(params.id!);
        return { ok: true, data: { source: toSourceWire(source) } };
      },
    },
    {
      method: 'PATCH',
      path: '/sources/:id',
      access: 'write',
      async handle(context) {
        const body = await context.json(sourcePatchBody);
        const source = await store.sources.update(context.params.id!, {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        });
        if (source === null) throw notFound(context.params.id!);
        return { ok: true, data: { source: toSourceWire(source) } };
      },
    },
    {
      method: 'POST',
      path: '/sources/:id/rotate-secret',
      access: 'write',
      async handle(context) {
        const body = (await context.json(sourceRotateBody.optional())) ?? {};
        const source = await store.sources.rotateSecret(context.params.id!, body.secret);
        if (source === null) throw notFound(context.params.id!);
        return { ok: true, data: toIssuedSourceWire(source) };
      },
    },
    {
      method: 'POST',
      path: '/sources/:id/rotate-token',
      access: 'write',
      async handle({ params }) {
        const source = await store.sources.rotateToken(params.id!);
        if (source === null) throw notFound(params.id!);
        return { ok: true, data: toIssuedSourceWire(source) };
      },
    },
    {
      method: 'DELETE',
      path: '/sources/:id',
      access: 'write',
      async handle({ params }) {
        // Its stored requests go with it.
        if (!(await store.sources.delete(params.id!))) throw notFound(params.id!);
        return { ok: true };
      },
    },
  ];
}
