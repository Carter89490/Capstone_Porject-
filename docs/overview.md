# Overview

## Purpose

Detect files that have been tampered with or corrupted. Every monitored file gets a SHA-256 fingerprint; if even one byte changes, the fingerprint changes. Comparing fingerprints over time shows which files are **new**, **changed**, or **deleted**.

## Parts and owners

| Part | What it does | Owner |
|---|---|---|
| **Client** | Runs on each monitored machine. Reads a config file, enrolls once, hashes files recursively, writes a local SQLite DB, uploads it. | Sam's side |
| **Secure API** | HTTPS transport, agent enrollment and API keys, portal login. Spec: `api-contract.md` (v1). | Teammates (implementation) |
| **Server** | Deploys agents, receives uploads, keeps one SQLite DB per client, merges each upload, serves data and reports. | Sam's side |
| **Web portal** | Login, scan imports, client file tree, trends, report export, Deploy new agent. Hosted by the server. Prototype: `web-portal-prototype.md`. | Team |

## Data flow

```
[portal] Deploy new agent -> server creates client + one-time enrollment token -> client-config.json
[config file] -> Client: enroll once (token -> API key, stored protected)
              -> walk dirs, SHA-256 each file, retry failures once
              -> local SQLite snapshot (table Data)
              -> upload over HTTPS: metadata (times, folders, agent info) + snapshot, Bearer API key
              -> Server: API key -> client ID -> that client's DB
              -> validate upload -> merge (new / changed / deleted / error) -> Scans row + Changes log
              -> portal reads -> scan imports, tree, trends, reports
```

## Core decisions (all decided; see the other docs for detail)

- .NET 10 LTS, C#, Microsoft.Data.Sqlite, ASP.NET Core.
- SHA-256 computed by streaming the file.
- Paths are normalized before storing, so the same file always gives the same string.
- The client sends a **fresh full snapshot** each scan; the server does all diffing.
- Each upload also carries **scan metadata**: only facts the server can't derive (start/finish time, folders scanned, agent details). Counts and changes are worked out by the server.
- The client scans at startup and then every `scanIntervalMinutes` (from its config).
- The client keeps at most 2 local snapshots; the server does long-term storage.
- Unreadable files and folders are retried once after the full scan, then recorded with a fixed error code in place of the hash.
- The shared `Data` table has **no client ID column**; the API key tells the server which client is sending.
- **Agents are deployed from the portal.** The server generates the client's config with a one-time enrollment token; the client swaps it for a per-client API key. No long-lived secret is ever in a config file.
- The server keeps **one SQLite DB per client ID**, created on the client's first upload.
- **Per-client DBs change only when that client's upload arrives.** The server's `index.db` also changes on enrollment, admin actions and logins. The portal and reports only read client data.
- History is never deleted: a changed hash adds a new row and marks the old one inactive (`active = 0`). Clients are revoked, never deleted.
- New, changed and deleted files are reported. Files whose folder was removed from a client's config are reported as **no longer monitored**, not deleted.
- A scan older than one already merged is **rejected** (old data never overwrites newer data); the server logs it and raises a **portal alert**.
- The server keeps the **2 newest raw uploads** per client and deletes older ones, like the client's snapshots.
- The agent runs as a **Windows Service**. Phase 1: run from the IDE on a test client machine. Phase 2: a published executable installed as the service.
- The portal is **plain HTML, CSS and JavaScript** (no framework), built from the prototype, with a **UTC / local time** toggle.
- HTTPS only, with a self-signed certificate the server creates itself; clients trust it by pinning its public key. API keys for agents, username + password sessions for the portal (roles `admin` and `viewer`).
- The server runs on Windows (demo: `DESKTOP-UBLTR99`, `192.151.132.6`).
- `active` stays the only extra column on the server's `Data` table; why a row is inactive comes from the `Changes` log.

## Glossary

- **Scan / snapshot**: one full pass of the client over its configured directories, saved as one SQLite file.
- **Scan metadata**: the small JSON sent with each snapshot (times, folders scanned, agent details).
- **Active row**: the server's current hash for a path (`active = 1`). At most one per path.
- **Superseded row**: an older hash for a path (`active = 0`), kept for history.
- **Error row**: a row whose `hash` is an error code instead of a hash. Always stored inactive on the server, and only when the error starts or changes; repeats are counted, not stored again.
- **Client ID**: the machine's identity, assigned by the server when the agent is deployed. On the server it comes only from authentication, never from the uploaded data.
- **Agent**: the client app installed on a monitored machine.
- **Enrollment token**: one-time, short-lived code in a deployed config; the client swaps it for its API key.
- **API key**: the agent's long-lived credential, stored protected on the machine and only as a salted hash on the server.
