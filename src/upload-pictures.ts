import { authenticate } from "@google-cloud/local-auth";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { google, type drive_v3 } from "googleapis";
import type { Credentials, OAuth2Client } from "google-auth-library";

const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"];
const DEFAULT_SOURCE = "/mnt/e/Users/djdun/Pictures";
const DEFAULT_CREDENTIALS = path.resolve("credentials.json");
const DEFAULT_TOKEN = path.join(
  homedir(),
  ".config",
  "icloud-drive-sync",
  "google-drive-token.json",
);
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

interface OAuthClientConfig {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris?: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris?: string[];
  };
}

async function saveTokens(tokenPath: string, credentials: Credentials): Promise<void> {
  await mkdir(path.dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, JSON.stringify(credentials, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(tokenPath, 0o600);
}

async function authorize(credentialsPath: string, tokenPath: string): Promise<OAuth2Client> {
  let credentials: OAuthClientConfig;
  try {
    credentials = JSON.parse(await readFile(credentialsPath, "utf8")) as OAuthClientConfig;
  } catch (error) {
    throw new Error(
      `Could not read Google OAuth credentials at "${credentialsPath}". ` +
        "Set GOOGLE_DRIVE_CREDENTIALS to your downloaded Desktop OAuth client JSON.",
      { cause: error },
    );
  }

  const clientConfig = credentials.installed ?? credentials.web;
  if (!clientConfig) {
    throw new Error(`No "installed" or "web" OAuth client found in "${credentialsPath}".`);
  }

  let savedTokens: Credentials | undefined;
  try {
    savedTokens = JSON.parse(await readFile(tokenPath, "utf8")) as Credentials;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new Error(`Could not read saved Google Drive tokens at "${tokenPath}".`, {
        cause: error,
      });
    }
  }

  let auth: OAuth2Client;
  if (savedTokens?.refresh_token) {
    auth = new google.auth.OAuth2(
      clientConfig.client_id,
      clientConfig.client_secret,
      clientConfig.redirect_uris?.[0],
    );
    auth.setCredentials(savedTokens);
  } else {
    console.log("Starting Google authorization in your browser...");
    auth = await authenticate({
      scopes: DRIVE_SCOPES,
      keyfilePath: credentialsPath,
    });
    await saveTokens(tokenPath, auth.credentials);
  }

  auth.on("tokens", (tokens) => {
    void saveTokens(tokenPath, { ...auth.credentials, ...tokens }).catch((error: unknown) => {
      console.error("Could not save refreshed Google Drive tokens:", error);
      process.exitCode = 1;
    });
  });
  return auth;
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findOrCreateFolder(
  drive: drive_v3.Drive,
  name: string,
  parentId: string,
): Promise<string> {
  const result = await drive.files.list({
    q: `name = '${escapeDriveQueryValue(name)}' and mimeType = '${FOLDER_MIME_TYPE}' ` +
      `and '${escapeDriveQueryValue(parentId)}' in parents and trashed = false`,
    fields: "files(id,name)",
    pageSize: 100,
  });
  const existingId = result.data.files?.[0]?.id;
  if (existingId) {
    return existingId;
  }

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: FOLDER_MIME_TYPE,
      parents: [parentId],
    },
    fields: "id",
  });
  if (!created.data.id) {
    throw new Error(`Google Drive did not return an ID for the "${name}" folder.`);
  }
  console.log(`Created Drive folder: ${name}`);
  return created.data.id;
}

async function fileExists(
  drive: drive_v3.Drive,
  name: string,
  parentId: string,
): Promise<boolean> {
  const result = await drive.files.list({
    q: `name = '${escapeDriveQueryValue(name)}' and '${escapeDriveQueryValue(parentId)}' in parents ` +
      "and mimeType != 'application/vnd.google-apps.folder' and trashed = false",
    fields: "files(id)",
    pageSize: 1,
  });
  return (result.data.files?.length ?? 0) > 0;
}

async function uploadDirectory(
  drive: drive_v3.Drive,
  localDirectory: string,
  driveFolderId: string,
  counts: { uploaded: number; skipped: number; failed: number },
): Promise<void> {
  const entries = await readdir(localDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const localPath = path.join(localDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      console.warn(`Skipping symbolic link: ${localPath}`);
      continue;
    }

    if (entry.isDirectory()) {
      const childFolderId = await findOrCreateFolder(drive, entry.name, driveFolderId);
      await uploadDirectory(drive, localPath, childFolderId, counts);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    try {
      if (await fileExists(drive, entry.name, driveFolderId)) {
        counts.skipped += 1;
        console.log(`Skipped existing file: ${localPath}`);
        continue;
      }

      await drive.files.create({
        requestBody: {
          name: entry.name,
          parents: [driveFolderId],
        },
        media: {
          mimeType: "application/octet-stream",
          body: createReadStream(localPath),
        },
        fields: "id",
      });
      counts.uploaded += 1;
      console.log(`Uploaded: ${localPath}`);
    } catch (error) {
      counts.failed += 1;
      console.error(`Failed to upload "${localPath}":`, error);
    }
  }
}

async function main(): Promise<void> {
  const sourceDirectory = path.resolve(process.argv[2] ?? DEFAULT_SOURCE);
  const credentialsPath = path.resolve(process.env.GOOGLE_DRIVE_CREDENTIALS ?? DEFAULT_CREDENTIALS);
  const tokenPath = path.resolve(process.env.GOOGLE_DRIVE_TOKEN ?? DEFAULT_TOKEN);

  const sourceStat = await stat(sourceDirectory);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Source path is not a directory: "${sourceDirectory}".`);
  }

  const auth = await authorize(credentialsPath, tokenPath);
  const drive = google.drive({ version: "v3", auth });
  const picturesFolderId = await findOrCreateFolder(drive, "Pictures", "root");
  const counts = { uploaded: 0, skipped: 0, failed: 0 };

  await uploadDirectory(drive, sourceDirectory, picturesFolderId, counts);
  console.log(
    `Finished. Uploaded: ${counts.uploaded}; skipped: ${counts.skipped}; failed: ${counts.failed}.`,
  );
  if (counts.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error("Google Drive upload failed:", error);
  process.exitCode = 1;
});
