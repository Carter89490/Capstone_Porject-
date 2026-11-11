# Open Questions

Not decided. **Don't invent answers.** Ask the team, or leave `TODO(open-question)` in the code with a pointer to this list. When one is decided, move it into the matching spec file and delete it here.

## Proposed in `api-contract.md` v1: confirm with the team

The API spec (2026-11-11) settles these. They stand unless the team (especially the API teammates) objects:

- Agents authenticate with a per-client **API key** (Bearer header), not client certificates.
- **Enrollment:** Deploy new agent issues a one-time token (24 h); the client swaps it for its key and stores it with DPAPI.
- Upload is the **whole snapshot file plus a JSON `metadata` part**; max 500 MiB.
- Client upload retries: 3 attempts, 5 s then 30 s, 10-minute timeout each.
- Portal login: username + password, session cookie, 5 failed logins → 15-minute lock. Roles `admin` and `viewer`; **every user sees every client**.
- Report export is a self-contained **HTML** file (print to PDF from the browser) plus a CSV change list. Reports are **not stored** on the server.
- Clients are **revoked, never deleted**; users are disabled, never deleted.
- The server's HTTPS certificate is **self-signed and created by the server**; clients trust it by **public-key pinning**.

## Still open

Nothing else right now.
