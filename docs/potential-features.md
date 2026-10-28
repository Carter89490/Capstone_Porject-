# Potential Features

Ideas for later. Not part of the current design; nothing here should be implemented until the team moves it into the matching spec file.

## Client

- **Don't scan the app's own files.** On config load, warn about (or skip) any configured directory that contains the client's own working folders: `outputDir`, the folder holding `logPath`, and the folder the client runs from. Otherwise every scan hashes earlier snapshots and the live log, which change every run. For now, keep the configured directories (e.g. `C:\Test`) separate from `C:\FIM` and the repo folder by hand.
