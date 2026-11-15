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
   create an OAuth client ID for a **Desktop app**. If the consent screen is in
   testing mode, add your Google account as a test user.
2. Download the OAuth client JSON and save it as `credentials.json` in this
   repository, or set `GOOGLE_DRIVE_CREDENTIALS` to its path. Do not commit this
   file. Google will ask you to grant the utility access to your Drive so it can
   find the destination folder and avoid duplicate uploads.
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
Drive root. It uploads sequentially; if any files fail, it reports them and
exits with a non-zero status.