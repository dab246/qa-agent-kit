# Authorization policy (revision 2026-10-01)

1. Any authenticated user reads their own settings.
2. Only administrators change global settings; others get HTTP 403 without the settings in the body.
3. Unauthenticated requests get HTTP 401.
4. A project is readable by its owner and by administrators; other users get HTTP 403 without project data.
