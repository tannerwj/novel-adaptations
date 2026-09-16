# Novel Adaptations — API contract

The versioned JSON API (`/api/v1`) that powers the client-rendered SPA.

**The canonical contract is `docs/openapi.yaml` (OpenAPI 3.1)** — kept in sync
with `src/api/v1.ts`. It documents every route: paths, methods, the `na_session`
cookie auth (401 unauthenticated / 403 non-admin), request/response schemas with
examples, the `{data,page,per_page,total}` pagination envelope, the
`{error:{code,message}}` error envelope (validation failures always answer 422),
and status codes.

Live, machine-readable, and interactive copies:

- Spec as JSON: `https://noveladaptations.com/api/openapi.json`
- Interactive docs: `https://noveladaptations.com/api/docs`

To change the API: edit `src/api/v1.ts`, update `docs/openapi.yaml` to match,
then run `python3 scripts/openapi-to-json.py` to regenerate `public/openapi.json`
(which the worker imports and serves). Commit all three files.
