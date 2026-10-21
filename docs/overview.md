# Overview

## Purpose

Detect files that have been tampered with or corrupted. Every monitored file gets a SHA-256 fingerprint; if even one byte changes, the fingerprint changes. Comparing fingerprints over time shows which files are **new**, **changed**, or **deleted**.

## Parts and owners

| Part | What it does | Owner |
|---|---|---|
| **Client** | Runs on each monitored machine. Reads a config file, hashes files recursively, writes a local SQLite DB, uploads it. | Sam's side |
| **Secure API** | HTTPS transport and per-client authentication (key or certificate) between client and server. | Teammates |
| **Server** | Receives uploads, keeps one SQLite DB per client, merges each upload, serves data and reports. | Sam's side |
| **Web portal** | Login and report generation, hosted by the server. UI/UX still pending. | Team (pending) |

## Data flow

```
[config file] -> Client: walk dirs, SHA-256 each file, retry failures once
              -> local SQLite snapshot (table Data)
              -> upload over HTTPS with per-client credential (secure API)
              -> Server: authenticate -> client ID -> that client's DB
              -> validate upload -> merge (new / changed / deleted / error)
              -> Changes log -> portal reads -> reports
```

## Core decisions (all decided; see the other docs for detail)

- .NET 10 LTS, C#, Microsoft.Data.Sqlite, ASP.NET Core.
- SHA-256 computed by streaming the file.
- Paths are normalized before storing, so the same file always gives the same string.
- The client sends a **fresh full snapshot** each scan; the server does all diffing.
- The client scans at startup and then every `scanIntervalHours` (from its config).
- Unreadable files and folders are retried once after the full scan, then recorded with a fixed error code in place of the hash.
- The shared `Data` table has **no client ID column**; the API tells the server which client is sending.
- The server keeps **one SQLite DB per client ID**; an unseen client ID gets a new DB.
- The server's DBs change **only when a client upload arrives**. The portal and reports only read.
- History is never deleted: a changed hash adds a new row and marks the old one inactive (`active = 0`).
- Deleted and new files are reported.
- HTTPS only, plus a per-client key or certificate.

## Glossary

- **Scan / snapshot**: one full pass of the client over its configured directories, saved as one SQLite file.
- **Active row**: the server's current hash for a path (`active = 1`). At most one per path.
- **Superseded row**: an older hash for a path (`active = 0`), kept for history.
- **Error row**: a row whose `hash` is an error code instead of a hash. Always stored inactive on the server.
- **Client ID**: the machine's identity. On the server it comes only from authentication, never from the uploaded data.
