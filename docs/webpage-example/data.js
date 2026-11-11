/*
 * FileGuard portal prototype: PLACEHOLDER DATA ONLY.
 *
 * Nothing here comes from a real server. The shapes mirror the planned design:
 *  - Each client has its own database on the server (one SQLite DB per client ID).
 *  - Data rows: filePath, fileSize (KiB), hash (SHA-256 hex or an error code), hashDate (Unix time).
 *  - Superseded hashes (active = 0) are kept as history.
 *  - Error codes: LOCKED, PERMISSION_DENIED, NOT_FOUND, UNREADABLE, DIR_UNREADABLE, DIR_NOT_FOUND.
 * Times are Unix seconds, like the hashDate column.
 */
(function () {
  "use strict";

  // Unix seconds from an ISO string, so the data below stays readable.
  function t(iso) { return Math.floor(Date.parse(iso) / 1000); }

  var H = [
    "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
    "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
    "d4735e3a265e16eee03f59718b9b5d03019c07d8b6c51f90da3a666eec13ab35",
    "4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce",
    "4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a",
    "ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d",
    "e7f6c011776e8db7cd330b54174fd76f7d0216b612387a5ffcfb81e6f0919683",
    "7902699be42c8a8e46fbbb4501726517e86b22c56a189f7625a6da49081b2451",
    "2c624232cdd221771294dfbb310aca000a0df6ac8b66b696d90ef06fdefb64a3",
    "19581e27de7ced00ff1ce50b2047e7a567c76b1cbaebabe5ef03f7c3017bb5b7",
    "4a44dc15364204a80fe80e9039455cc1608281820fe2b24f1e5233ade6af1dd5",
    "4fc82b26aecb47d2868c4efbe3581732a3e7cbcc6c2efb32062c08170a05eeb8",
    "6b51d431df5d7f141cbececcf79edf3dd861c3b4069f0b11661a3eefacbba918",
    "3fdba35f04dc8c462986c992bcf875546257113072a909c162f7e470e581e278",
    "8527a891e224136950ff32ca212b45bc93f69fbb801c3b1ebedac52775f99e61",
    "e629fa6598d732768f7c726b4b621285f9c3b85303900aa912017db7617d8bdb"
  ];

  // Shorthand builders for the tree.
  function dir(name, path, children, extra) {
    var d = { type: "dir", name: name, path: path, children: children || [] };
    for (var k in extra) d[k] = extra[k];
    return d;
  }
  // history: newest first. First entry is the active hash (active = 1); the rest are superseded (active = 0).
  function file(name, path, sizeKiB, firstSeen, history, extra) {
    var f = {
      type: "file", name: name, path: path, sizeKiB: sizeKiB,
      firstSeen: firstSeen, history: history, status: "ok"
    };
    for (var k in extra) f[k] = extra[k];
    return f;
  }

  var C1 = "C:/FileGuard-Watch";
  var C2 = "/var/www";

  window.FILEGUARD_DATA = {
    generatedNote: "Placeholder data for the UI prototype.",
    errorCodes: {
      LOCKED: "File was in use by another process on both attempts.",
      PERMISSION_DENIED: "The client account is not allowed to read the file.",
      NOT_FOUND: "File disappeared between listing and hashing.",
      UNREADABLE: "Read failed for another reason (I/O error, bad sector).",
      DIR_UNREADABLE: "The client could not list this folder. Known files under it stay active.",
      DIR_NOT_FOUND: "A root folder from the client config does not exist."
    },
    clients: [
      {
        id: "CLIENT-001",
        name: "WS-ACCT-01",
        os: "Windows 11 Pro",
        scanEveryHours: 6,
        roots: [C1 + "/Finance", C1 + "/HR"],
        lastContact: t("2026-11-11T12:04:00Z"),
        scans: [
          { id: 101, started: t("2026-11-10T00:00:00Z"), finished: t("2026-11-10T00:01:12Z"), dirsScanned: 3, filesFound: 3, filesHashed: 3, failed: 1, newFiles: 3, changed: 0, deleted: 0,
            failures: [{ path: C1 + "/HR", code: "DIR_UNREADABLE" }] },
          { id: 102, started: t("2026-11-10T06:00:00Z"), finished: t("2026-11-10T06:01:05Z"), dirsScanned: 3, filesFound: 3, filesHashed: 3, failed: 1, newFiles: 0, changed: 0, deleted: 0,
            failures: [{ path: C1 + "/HR", code: "DIR_UNREADABLE" }] },
          { id: 103, started: t("2026-11-10T12:00:00Z"), finished: t("2026-11-10T12:01:40Z"), dirsScanned: 3, filesFound: 4, filesHashed: 3, failed: 2, newFiles: 1, changed: 0, deleted: 0,
            failures: [{ path: C1 + "/Finance/Payroll/payroll_2026_11.xlsx", code: "LOCKED" }, { path: C1 + "/HR", code: "DIR_UNREADABLE" }] },
          { id: 104, started: t("2026-11-10T18:00:00Z"), finished: t("2026-11-10T18:01:09Z"), dirsScanned: 3, filesFound: 4, filesHashed: 4, failed: 1, newFiles: 0, changed: 0, deleted: 0,
            failures: [{ path: C1 + "/HR", code: "DIR_UNREADABLE" }] },
          { id: 105, started: t("2026-11-11T00:00:00Z"), finished: t("2026-11-11T00:01:15Z"), dirsScanned: 3, filesFound: 4, filesHashed: 4, failed: 1, newFiles: 0, changed: 1, deleted: 0,
            failures: [{ path: C1 + "/HR", code: "DIR_UNREADABLE" }] },
          { id: 106, started: t("2026-11-11T06:00:00Z"), finished: t("2026-11-11T06:01:02Z"), dirsScanned: 3, filesFound: 4, filesHashed: 4, failed: 1, newFiles: 0, changed: 0, deleted: 0,
            failures: [{ path: C1 + "/HR", code: "DIR_UNREADABLE" }] },
          { id: 107, started: t("2026-11-11T12:00:00Z"), finished: t("2026-11-11T12:01:21Z"), dirsScanned: 3, filesFound: 4, filesHashed: 4, failed: 1, newFiles: 0, changed: 1, deleted: 0,
            failures: [{ path: C1 + "/HR", code: "DIR_UNREADABLE" }] }
        ],
        // 8 nodes: 4 folders, 4 files
        tree: [
          dir("Finance", C1 + "/Finance", [
            dir("Payroll", C1 + "/Finance/Payroll", [
              file("payroll_2026_10.xlsx", C1 + "/Finance/Payroll/payroll_2026_10.xlsx", 184, t("2026-11-10T00:00:41Z"),
                [{ hash: H[0], hashDate: t("2026-11-11T12:00:41Z") }]),
              file("payroll_2026_11.xlsx", C1 + "/Finance/Payroll/payroll_2026_11.xlsx", 191, t("2026-11-10T12:00:52Z"),
                [{ hash: H[1], hashDate: t("2026-11-11T12:00:55Z") },
                 { hash: H[2], hashDate: t("2026-11-10T18:00:50Z"), active: 0 },
                 { hash: "LOCKED", hashDate: t("2026-11-10T12:01:38Z"), active: 0 }],
                { status: "changed" })
            ]),
            dir("Invoices", C1 + "/Finance/Invoices", [
              file("INV-1042.pdf", C1 + "/Finance/Invoices/INV-1042.pdf", 96, t("2026-11-10T00:00:58Z"),
                [{ hash: H[3], hashDate: t("2026-11-11T12:01:02Z") }])
            ]),
            file("budget_fy27.xlsx", C1 + "/Finance/budget_fy27.xlsx", 412, t("2026-11-10T00:01:05Z"),
              [{ hash: H[4], hashDate: t("2026-11-11T00:01:09Z") },
               { hash: H[5], hashDate: t("2026-11-10T00:01:05Z"), active: 0 }],
              { status: "changed" })
          ]),
          dir("HR", C1 + "/HR", [], { status: "error", errorCode: "DIR_UNREADABLE", firstSeen: t("2026-11-10T00:01:10Z") })
        ]
      },
      {
        id: "CLIENT-002",
        name: "SRV-WEB-02",
        os: "Ubuntu Server 24.04 LTS",
        scanEveryHours: 6,
        roots: [C2, "/etc/nginx"],
        lastContact: t("2026-11-11T12:33:00Z"),
        scans: [
          { id: 201, started: t("2026-11-10T00:30:00Z"), finished: t("2026-11-10T00:30:18Z"), dirsScanned: 4, filesFound: 5, filesHashed: 4, failed: 1, newFiles: 5, changed: 0, deleted: 0,
            failures: [{ path: "/etc/nginx/ssl.key", code: "PERMISSION_DENIED" }] },
          { id: 202, started: t("2026-11-10T06:30:00Z"), finished: t("2026-11-10T06:30:16Z"), dirsScanned: 4, filesFound: 5, filesHashed: 4, failed: 1, newFiles: 0, changed: 0, deleted: 0,
            failures: [{ path: "/etc/nginx/ssl.key", code: "PERMISSION_DENIED" }] },
          { id: 203, started: t("2026-11-10T12:30:00Z"), finished: t("2026-11-10T12:30:17Z"), dirsScanned: 4, filesFound: 5, filesHashed: 4, failed: 1, newFiles: 0, changed: 0, deleted: 0,
            failures: [{ path: "/etc/nginx/ssl.key", code: "PERMISSION_DENIED" }] },
          { id: 204, started: t("2026-11-10T18:30:00Z"), finished: t("2026-11-10T18:30:19Z"), dirsScanned: 4, filesFound: 5, filesHashed: 4, failed: 1, newFiles: 0, changed: 1, deleted: 0,
            failures: [{ path: "/etc/nginx/ssl.key", code: "PERMISSION_DENIED" }] },
          { id: 205, started: t("2026-11-11T00:30:00Z"), finished: t("2026-11-11T00:30:15Z"), dirsScanned: 4, filesFound: 5, filesHashed: 4, failed: 1, newFiles: 0, changed: 1, deleted: 0,
            failures: [{ path: "/etc/nginx/ssl.key", code: "PERMISSION_DENIED" }] },
          { id: 206, started: t("2026-11-11T06:30:00Z"), finished: t("2026-11-11T06:30:14Z"), dirsScanned: 4, filesFound: 4, filesHashed: 3, failed: 1, newFiles: 0, changed: 0, deleted: 1,
            failures: [{ path: "/etc/nginx/ssl.key", code: "PERMISSION_DENIED" }] },
          { id: 207, started: t("2026-11-11T12:30:00Z"), finished: t("2026-11-11T12:30:22Z"), dirsScanned: 4, filesFound: 5, filesHashed: 4, failed: 1, newFiles: 1, changed: 0, deleted: 0,
            failures: [{ path: "/etc/nginx/ssl.key", code: "PERMISSION_DENIED" }] }
        ],
        // 10 nodes: 4 folders, 6 files
        tree: [
          dir("www", C2, [
            dir("html", C2 + "/html", [
              file("index.html", C2 + "/html/index.html", 12, t("2026-11-10T00:30:03Z"),
                [{ hash: H[6], hashDate: t("2026-11-10T18:30:04Z") },
                 { hash: H[7], hashDate: t("2026-11-10T00:30:03Z"), active: 0 }],
                { status: "changed" }),
              file("login.php", C2 + "/html/login.php", 7, t("2026-11-10T00:30:05Z"),
                [{ hash: H[8], hashDate: t("2026-11-11T00:30:06Z") }],
                { status: "deleted", deletedAt: t("2026-11-11T06:30:14Z") }),
              file("shell.php", C2 + "/html/shell.php", 3, t("2026-11-11T12:30:20Z"),
                [{ hash: H[9], hashDate: t("2026-11-11T12:30:20Z") }],
                { status: "new" }),
              dir("assets", C2 + "/html/assets", [
                file("app.js", C2 + "/html/assets/app.js", 48, t("2026-11-10T00:30:08Z"),
                  [{ hash: H[10], hashDate: t("2026-11-11T00:30:09Z") },
                   { hash: H[11], hashDate: t("2026-11-10T00:30:08Z"), active: 0 }],
                  { status: "changed" })
              ])
            ])
          ]),
          dir("nginx", "/etc/nginx", [
            file("nginx.conf", "/etc/nginx/nginx.conf", 2, t("2026-11-10T00:30:11Z"),
              [{ hash: H[12], hashDate: t("2026-11-11T12:30:12Z") }]),
            file("ssl.key", "/etc/nginx/ssl.key", 2, t("2026-11-10T00:30:12Z"),
              [{ hash: "PERMISSION_DENIED", hashDate: t("2026-11-11T12:30:13Z"), active: 0 }],
              { status: "error", errorCode: "PERMISSION_DENIED" })
          ])
        ]
      }
    ]
  };
})();
