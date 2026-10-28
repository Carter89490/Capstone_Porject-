# Open Questions

Not decided. **Don't invent answers.** Ask the team, or leave `TODO(open-question)` in the code with a pointer to this list. When one is decided, move it into the matching spec file and delete it here.

## Portal

- **Portal UI/UX**: layout, pages, and which reports are needed. This will decide what extra data the server keeps and which portal endpoints survive.
- Should some portal users see only some clients?
- Report history, report size limits, or streaming large reports.

## API (teammates)

- Key vs. certificate, header names, upload format (whole DB file vs. JSON rows).
- **Client registration**: who issues per-client credentials, and whether an unknown but authenticated client should get a DB automatically (current behavior: yes).
- Upload retry policy (client) and maximum upload size (server; placeholder 500 MB).

## Server

- Keep raw uploaded DB files for an audit trail, or delete after merge (current: delete).
- Out-of-order uploads are rejected with 409; team to confirm.
- Deleted vs. superseded both use `active = 0` and are told apart by the `Changes` log. If the portal needs it without the log, that would take another column.
- Effect of short scan intervals on DB growth for large clients, once real file counts are known.
