# icloud_drive_sync

## Upload Pictures to Google Drive

This TypeScript utility recursively uploads files from a local Pictures directory
to a `Pictures` folder in the root of your Google Drive. It preserves
subdirectories (including empty ones) and does not overwrite existing files:
files with the same name in the same Drive folder are skipped.

### Setup

Use Node.js 24 with npm installed in WSL. If you use nvm, run `nvm use` in the
repository to select the version from `.nvmrc`.

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a
   project, enable the Google Drive API, configure the OAuth consent screen, and
   create an OAuth client ID for a **Desktop app**. Declare `drive.file` as the
   Drive scope. If the consent screen is in testing mode, add your Google
   account as a test user.
2. Download the OAuth client JSON and save it as `credentials.json` in this
   repository, or set `GOOGLE_DRIVE_CREDENTIALS` to its path. Do not commit this
   file. The utility requests the `drive.file` scope, which limits access to
   files it creates or that you explicitly select for it. This scope still
   allows modifying accessible files; this script only creates files and reads
   metadata, and does not update or delete them.
3. From WSL, install dependencies and build:

   ```sh
   npm install
   npm run build
   ```

### Run

The default source is `/mnt/e/Users/djdun/Pictures`:

```sh
npm run upload
```

Or specify a different source directory:

```sh
npm run upload -- /mnt/e/Users/djdun/Pictures
```

On the first run, a browser window opens for Google authorization. The refresh
token is stored at `~/.config/icloud-drive-sync/google-drive-token.json` (or
`GOOGLE_DRIVE_TOKEN` if set). The utility finds or creates `Pictures` at the
Drive root. With `drive.file`, it may not see a `Pictures` folder created
outside this utility, and could create a second folder with that name. It
uploads sequentially and prints a per-file progress count.

If you previously authorized the utility with full Drive access, revoke its
access in your Google Account, delete the saved token file, then run it again.
The utility rejects a saved token that does not confirm the limited `drive.file`
scope.

After each uploaded or skipped file, progress is saved to a checkpoint under
`~/.config/icloud-drive-sync/` (or the path in `GOOGLE_DRIVE_STATE`). If a run
is interrupted, run the same command again to resume; completed files are
skipped, while an unfinished file is checked in Drive and uploaded if it is not
there. The checkpoint tracks source files by relative path, size, and
modification time. If any files fail, the utility reports them and exits with a
non-zero status.