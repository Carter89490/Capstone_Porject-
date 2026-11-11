# FileGuard Web Portal Prototype

A clickable, static prototype of the FileGuard server's web portal. It shows the planned layout and flow so the team can agree on the portal UI before the ASP.NET Core server work starts. Nothing in it talks to a server: every number, path and hash is placeholder data.

Files live in [`docs/webpage-example/`](webpage-example/).

## How to view it

1. Open `docs/webpage-example/index.html` in any modern browser (double-click it, or drag it into a browser window). No install, build step or web server is needed.
2. Type anything (or nothing) into the username and password boxes and press **Sign in**.
3. The home page opens with three tabs and a report tray along the bottom.

The pages load the Ubuntu font from Google Fonts. Offline, they fall back to the system font and still work.

## Files

| File | Purpose |
|---|---|
| `index.html` | Login page. The fields accept text but are not checked. Sign in goes straight to `home.html`. |
| `home.html` | Main portal page: top bar, three tabs, report tray, "Report exported!" popup. |
| `styles.css` | All styling. Colors are CSS variables at the top of the file. |
| `data.js` | Placeholder data for two clients (scans, folder tree, hash history). |
| `app.js` | Page behaviour: tabs, scan table, folder tree, chart, report tray. Plain JavaScript, no libraries. |

## Pages and features

### Login (`index.html`)

Username and password boxes plus a **Sign in** button. The typed values are never sent or stored. The real portal will need proper authentication (see Open questions).

### Tab 1: Scan imports (main tab)

Shows each database upload from the clients, newest first.

- **Client** dropdown: all clients or one client.
- **Summary tiles:** files found, files hashed and failed hashes from each client's latest scan, plus hash changes across the scans shown.
- **Table, one row per scan:** client name and ID, scan start time, duration, folders scanned, files found, files hashed, failed, new, changed, deleted.
- Click a row (or press Enter on it) to expand it and see each failed path with its error code (`LOCKED`, `PERMISSION_DENIED`, `DIR_UNREADABLE`, and so on).
- **+ Add to report** adds the current summary and table to the report.

### Tab 2: Client files (folder tree)

Modelled on the Group Policy Management Editor: a tree on the left and a details pane on the right.

- **Client** dropdown picks which client's tree to show.
- The tree starts at the client machine, then its monitored root folders, then subfolders, then files. Click the arrow (or a selected row) to expand or collapse. Arrow keys also work. **Expand all / Collapse all** toggles every folder.
- Status badges flag files that need attention: **Changed**, **New**, **Deleted**, or an error code.
- **Selecting the client** shows client ID, OS, monitored roots, scan interval, last upload and last scan totals.
- **Selecting a folder** shows its path, subfolder and file counts, whether anything under it needs attention, and a list of its contents. A folder the client could not read shows its `DIR_UNREADABLE` error.
- **Selecting a file** shows name, path, size, current SHA-256, date found, date of last hash change, last checked time, and the full hash history. Older hashes show as **Superseded** (the `active = 0` rows) and failed attempts show their error code.
- **+ Add selection to report** adds whatever is shown in the details pane.

### Tab 3: Trends (line chart)

- **Measure** dropdown: files found, files hashed, failed hashes, changed hashes, new files, or deleted files per scan.
- **Client** dropdown: all clients (one line each) or one client.
- Hover a point to see the client, scan number, time and value.
- **+ Add chart to report** adds the chart as it is currently set up.
- The chart is drawn as plain SVG by `app.js`, so no chart library is needed.

### Report tray and export

The tray is fixed to the bottom of every tab.

- The badge counts items in the report. **Show items** lists them, each with a **Remove** button. **Clear** empties the report.
- The report lasts until the browser tab is closed (it uses `sessionStorage`).
- **Export report** does not create a file in this prototype. It shows a "Report exported!" popup with the number of items.

## Placeholder data

Two clients, each with seven scans six hours apart (10 to 11 November 2026, shown in UTC):

| Client | Machine | Monitored roots | Tree items | Story the data tells |
|---|---|---|---|---|
| CLIENT-001 | WS-ACCT-01 (Windows 11) | `C:/FileGuard-Watch/Finance`, `C:/FileGuard-Watch/HR` | 4 folders, 4 files | `HR` is unreadable on every scan. A new payroll file is `LOCKED` on its first scan, then hashes normally. Two spreadsheets change. |
| CLIENT-002 | SRV-WEB-02 (Ubuntu Server) | `/var/www`, `/etc/nginx` | 4 folders, 6 files | `ssl.key` is `PERMISSION_DENIED`. `index.html` and `app.js` change, `login.php` is deleted, and a new `shell.php` appears: a tampering scenario for demos. |

`CLIENT-002` is example data only: FileGuard clients are Windows only (decided by Sam, 2026-11-12).

The data follows the design already agreed for the real system:

- One database per client on the server.
- Data rows hold `filePath`, `fileSize` (KiB), `hash` (64 hex SHA-256 or an error code) and `hashDate` (Unix time). Times in `data.js` are Unix seconds.
- A changed hash adds a new row and marks the old one superseded (`active = 0`). Error rows are kept with `active = 0` and never replace a good hash.
- Paths are normalized with forward slashes.

The per-scan counts (files found, hashed, failed, new, changed, deleted) and the folder tree are what the portal is expected to show. They are not in the `Data` table, so the server stores them per scan in its `Scans` table (`server-spec.md`):

- **From the client**, in the upload's `metadata` part: scan start and finish times (duration), folders scanned, and the client's OS, hostname, version, scan interval and monitored roots.
- **Counted by the server** from the uploaded snapshot: files found, hashed and failed.
- **From the server's merge**: new, changed, deleted and unchanged.

## Colors

Ubuntu-style palette, defined at the top of `styles.css`:

| Variable | Hex | Used for |
|---|---|---|
| `--orange` | `#E95420` | Buttons, active tab underline, selected tree row, first chart line |
| `--aubergine` | `#772953` | Tab bar, secondary buttons, second chart line |
| `--aubergine-dark` | `#2C001E` | Top bar, headings |
| `--purple` | `#77216F` | "New" badge |
| `--warm-grey` | `#AEA79F` | Tree guide lines, chart axis |

## What the real portal adds

All of these are specified in [`api-contract.md`](api-contract.md):

- Real login (hashed passwords, session cookie, lockout) over HTTPS, with `admin` and `viewer` roles.
- Data from the Portal data API: `/portal/summary` and `/portal/scans` (scan imports tab), `/clients/{id}`, `/tree` and `/file` (client files tab), `/trends` (trends tab).
- **Deploy new agent** button near the top (admins only): a form for computer name, OS, scan interval, optional folders and notes, which downloads a ready-to-use `client-config.json` with a one-time enrollment token.
- Client actions for admins: issue a new config, revoke, edit name/notes. A small user management page.
- **Alerts** indicator in the top bar (count of unacknowledged alerts, e.g. a rejected out-of-order scan), opening a list where admins acknowledge them (`/portal/alerts`).
- **Time zone toggle** in the top bar: **UTC** or **Local** (the viewer's computer time zone), remembered per browser. Applies to every time on the page and in report exports.
- A **No longer monitored** badge for files whose folder was removed from the client's config (`UNMONITORED`).
- Built the same way as the prototype: **plain HTML, CSS and JavaScript, no framework** (decided by Sam, 2026-11-12), served from `Server/wwwroot`.
- Report export as a self-contained HTML file (`/reports/export`), plus a CSV change list. Reports are not stored on the server.
- Larger data sets: the scan table is paged and the folder tree loads one level at a time.
