# File Integrity Monitor (Senior Design)

An app that detects tampering or corruption of files. A **client** hashes files on each monitored machine and uploads the results to a **central server**. The server stores results per client, compares each upload with earlier ones, and serves reports to a web portal.

The full specification lives in `docs/`. The files imported below are part of these instructions; the pseudocode files are long, so read them when you work on that part.

@docs/overview.md
@docs/data-model.md

Read before working on that area:

- Client work: `docs/client-spec.md`, then `docs/client-pseudocode.md`
- Server work: `docs/server-spec.md`, then `docs/server-pseudocode.md`
- Anything touching the client/server boundary: `docs/api-contract.md`
- Repo, build, and tooling setup: `docs/dev-setup.md`
- What is still undecided: `docs/open-questions.md`
- Ideas for later (don't implement until moved into a spec): `docs/potential-features.md`

## Rules for Claude

- **Follow the decisions in `docs/` exactly.** If a request conflicts with them, say so and point to the conflicting decision instead of silently changing the design.
- **Don't invent answers to open questions** (`docs/open-questions.md`). Ask, or leave a `TODO(open-question)` comment in the code.
- **The secure API belongs to teammates.** Code against the contract in `docs/api-contract.md` and mark guesses with `API_PLACEHOLDER`. Don't redesign the auth scheme.
- **Don't change the shared `Data` schema** (column names, types, units) or the error-code list without the whole team agreeing. Client, API, and server all depend on them.
- **The portal UI/UX is not designed yet.** Mark portal guesses with `ASSUMPTION(portal-pending)` and keep portal endpoints generic.

## Stack

- C# on **.NET 10 (LTS)**, solution `Integrity.slnx` with projects `Client` (console), `Server` (ASP.NET Core), `Tests` (xUnit)
- **Microsoft.Data.Sqlite** for all SQLite access (no EF Core unless the team agrees)
- **ASP.NET Core** for the server API and web portal
- **SHA-256**, streamed (`SHA256.HashDataAsync(stream)`); never load a whole file into memory
- VS Code + C# Dev Kit; SDK pinned in `global.json`; shared `Directory.Build.props` and `Directory.Packages.props` (central package versions)

## Commands

```
dotnet build          # must finish with 0 warnings, 0 errors (warnings are errors)
dotnet test
dotnet format         # run before every push
dotnet run --project Client -- client-config.json
dotnet run --project Server
```

## Code conventions

- Async I/O for file reads, DB access, and network calls.
- Parameterized SQL only; never build SQL by concatenating strings.
- Never hard-code keys, certs, or passwords. Use config, environment variables, or `dotnet user-secrets`. Never commit real configs, keys, certs, or `*.db` files.
- Nullable reference types are on; keep the build warning-free.
- One bad file or folder must never stop a scan; one bad upload must never corrupt a client's DB (merges are a single transaction).
- Add `PackageReference` entries without a `Version`; versions go in `Directory.Packages.props`.
- Don't edit `global.json`, `Directory.*.props`, or `.vscode/` unless asked; those changes go through a team PR.
- Work on branches and merge through pull requests.
