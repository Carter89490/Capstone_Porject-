# Team Dev Setup Checklist (VS Code + .NET 10)

Goal: every teammate builds, runs, formats, and debugs the project the same way, so "works on my machine" problems don't happen.

There are two kinds of steps here:

- **Part A: each person does once** on their own computer.
- **Part B: one person does once** in the repo. Everyone else gets it automatically when they clone or pull, because the files are committed.

---

## Part A: Each teammate (on your own machine)

### 1. Install the tools

- [ ] **Git** from https://git-scm.com. Then set your name and email:
  - `git config --global user.name "Your Name"`
  - `git config --global user.email "you@school.edu"`
- [ ] **.NET 10 SDK** (the SDK, not just the runtime) from https://dotnet.microsoft.com/download/dotnet/10.0
- [ ] **VS Code** from https://code.visualstudio.com

### 2. Check the install

Run these in a terminal and compare with the team:

- [ ] `dotnet --list-sdks` shows a `10.0.x` SDK
- [ ] `dotnet --info` runs without errors
- [ ] `git --version` works

### 3. Trust the local HTTPS certificate (once per machine)

- [ ] `dotnet dev-certs https --trust`

This lets the ASP.NET Core server run on HTTPS locally without browser warnings.

### 4. Clone and open the repo

- [ ] Clone the team repo and open the **repo root folder** in VS Code (File > Open Folder), not a single project folder.
- [ ] When VS Code asks **"Install recommended extensions?"**, click **Install**. This installs the team's extension list from `.vscode/extensions.json` (Part B).
- [ ] Sign in to C# Dev Kit when prompted (free for students and individuals).
- [ ] When asked **"Do you trust the authors of the files in this folder?"**, click **Yes**.

### 5. Confirm it works

- [ ] Run `dotnet build` at the repo root. It should finish with **0 errors and 0 warnings**.
- [ ] Press **F5**, choose the Server or Client config, and confirm a breakpoint gets hit.
- [ ] Run `dotnet test` (once tests exist) and confirm everything passes.

### 6. Don't override team settings

- [ ] Don't change formatting, tab size, or line endings in your **User** settings for this project. The workspace settings in `.vscode/settings.json` win, and they are the same for everyone.
- [ ] If you use VS Code Settings Sync, that's fine; it only syncs your personal settings, not the repo's.

---

## Part B: One person sets up the repo (commit these files)

Do these once, commit, and push. After that, everyone gets them by pulling.

### 1. Create the solution and projects

```
dotnet new sln -n Integrity
dotnet new console -n Client
dotnet new webapi -n Server
dotnet new xunit -n Tests
dotnet sln add Client Server Tests
dotnet add Client package Microsoft.Data.Sqlite
dotnet add Server package Microsoft.Data.Sqlite
```

With the .NET 10 SDK, `dotnet new sln` creates `Integrity.slnx` (the new solution format) and new projects target `net10.0`.

### 2. Pin the SDK version: `global.json` (repo root)

Run `dotnet --list-sdks`, pick the 10.0 version the team has, and pin it:

```json
{
  "sdk": {
    "version": "10.0.100",
    "rollForward": "latestFeature"
  }
}
```

Replace `10.0.100` with the actual version. If someone has an older SDK, `dotnet build` tells them to update instead of silently building with a different version.

### 3. Shared build settings: `Directory.Build.props` (repo root)

Applies to every project, so the Client, Server and Tests all match:

```xml
<Project>
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>
    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>
  </PropertyGroup>
</Project>
```

You can then remove `TargetFramework`, `Nullable` and `ImplicitUsings` from each `.csproj`.

### 4. Same package versions for everyone: `Directory.Packages.props` (repo root)

Central Package Management keeps all NuGet versions in one file:

```xml
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Microsoft.Data.Sqlite" Version="10.0.0" />
  </ItemGroup>
</Project>
```

- Use the current 10.0.x version from nuget.org.
- In each `.csproj`, write `<PackageReference Include="Microsoft.Data.Sqlite" />` with **no** `Version`.
- Commit the generated `packages.lock.json` files. They lock exact versions, including dependencies.
- To upgrade a package, change it in this one file and commit.

### 5. Code style: `.editorconfig` (repo root)

- [ ] Run `dotnet new editorconfig` to generate the standard .NET one.
- [ ] Commit it. VS Code, `dotnet build` and `dotnet format` all read it.
- [ ] Before pushing, anyone can run `dotnet format` to fix style automatically.

### 6. Line endings: `.gitattributes` (repo root)

Prevents Windows/Mac/Linux teammates from creating whole-file diffs:

```
* text=auto eol=lf
*.cmd text eol=crlf
*.bat text eol=crlf
*.db binary
*.sqlite binary
```

### 7. What not to commit: `.gitignore` (repo root)

- [ ] Run `dotnet new gitignore`.
- [ ] Add these lines at the bottom so local test databases and secrets stay out of Git:

```
*.db
*.db-shm
*.db-wal
appsettings.Development.local.json
```

### 8. Recommended extensions: `.vscode/extensions.json`

```json
{
  "recommendations": [
    "ms-dotnettools.csdevkit",
    "ms-dotnettools.csharp",
    "ms-dotnettools.vscode-dotnet-runtime",
    "editorconfig.editorconfig",
    "qwtel.sqlite-viewer"
  ]
}
```

C# Dev Kit gives Solution Explorer, IntelliSense, Test Explorer and debugging. SQLite Viewer lets you open the client and server `.db` files.

### 9. Workspace settings: `.vscode/settings.json`

```json
{
  "dotnet.defaultSolution": "Integrity.slnx",
  "editor.formatOnSave": true,
  "editor.insertSpaces": true,
  "editor.tabSize": 4,
  "files.eol": "\n",
  "files.insertFinalNewline": true,
  "files.trimTrailingWhitespace": true,
  "[csharp]": {
    "editor.defaultFormatter": "ms-dotnettools.csharp"
  }
}
```

### 10. Same run/debug buttons: `.vscode/launch.json` and `.vscode/tasks.json`

- [ ] Open the Run and Debug panel, click **create a launch.json file**, choose **C#**, and add a config for the Server and one for the Client.
- [ ] Commit both files so everyone's **F5** does the same thing.
- [ ] Optional: add a compound config that starts Server and Client together.

### 11. Config files and secrets

- [ ] Commit a **sample** client config (for example `Client/client-config.example.json`) with the directory list, client ID and scan interval (minutes), using fake values.
- [ ] Each person copies it to their real config locally. Real configs, client keys and certs are **never** committed.
- [ ] For the server, use `dotnet user-secrets` for anything secret during development:
  - `dotnet user-secrets init --project Server`
  - `dotnet user-secrets set "SomeKey" "value" --project Server`

### 12. Write it down: `README.md` (repo root)

- [ ] Add a short "Getting started" section that points to this checklist and lists the commands from Part A, step 5.

---

## Team habits (keeps setups the same over time)

- [ ] **Never edit `global.json`, `Directory.*.props` or `.vscode/` files alone.** Propose the change in a pull request so everyone gets it at once.
- [ ] **Pull before you start work** and run `dotnet build` after pulling.
- [ ] **Work on branches** and merge with pull requests; don't push straight to `main`.
- [ ] Run `dotnet format` and `dotnet build` before every push. With warnings treated as errors, a clean build means your code matches the team style.
- [ ] Optional but recommended: a GitHub Actions workflow that runs `dotnet build` and `dotnet test` on every pull request, using the SDK from `global.json`. This catches setup drift automatically.

---

## Quick "is my setup right?" check

Everyone should get the same results:

| Check | Expected |
|---|---|
| `dotnet --version` (in repo folder) | The version in `global.json` (or newer patch) |
| `dotnet build` | 0 warnings, 0 errors |
| `dotnet test` | All pass |
| F5 on Server | Opens on HTTPS with no certificate warning |
| Extensions panel, "Recommended" | All installed |
