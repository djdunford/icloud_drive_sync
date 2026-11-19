import { authenticate } from "@google-cloud/local-auth";
import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { google, type drive_v3 } from "googleapis";
import type { Credentials, OAuth2Client } from "google-auth-library";

const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_SCOPES = [DRIVE_FILE_SCOPE];
const DEFAULT_SOURCE = "/mnt/e/Users/djdun/Pictures";
const DEFAULT_CREDENTIALS = path.resolve("credentials.json");
const DEFAULT_TOKEN = path.join(
  homedir(),
  ".config",
  "icloud-drive-sync",
  "google-drive-token.json",
);
const DEFAULT_STATE_DIRECTORY = path.dirname(DEFAULT_TOKEN);
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

interface LocalFile {
  absolutePath: string;
  relativePath: string;
  size: number;
  modifiedAt: number;
}

type CheckpointEntry = {
  fingerprint: string;
  status: "uploaded" | "skipped";
};

interface UploadCheckpoint {
  version: 1;
  sourceDirectory: string;
  files: Record<string, CheckpointEntry>;
}

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
    validateDriveScope(savedTokens, tokenPath);
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
    validateDriveScope(auth.credentials, tokenPath);
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

function validateDriveScope(credentials: Credentials, tokenPath: string): void {
  const driveScopes = (credentials.scope ?? "")
    .split(/\s+/)
    .filter((scope) => scope.startsWith("https://www.googleapis.com/auth/drive"));
  if (driveScopes.length !== 1 || driveScopes[0] !== DRIVE_FILE_SCOPE) {
    throw new Error(
      `The Google token at "${tokenPath}" does not confirm the limited Drive file permission. ` +
        "Revoke this app's access in your Google Account, delete this token file, and run again " +
        "to authorize with drive.file.",
    );
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getFingerprint(file: LocalFile): string {
  return `${file.size}:${file.modifiedAt}`;
}

async function collectSourceTree(
  sourceDirectory: string,
): Promise<{ files: LocalFile[]; directories: string[] }> {
  const files: LocalFile[] = [];
  const directories = [""];

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        console.warn(`Skipping symbolic link: ${absolutePath}`);
      } else if (entry.isDirectory()) {
        directories.push(relativePath);
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        const fileStat = await stat(absolutePath);
        files.push({
          absolutePath,
          relativePath,
          size: fileStat.size,
          modifiedAt: fileStat.mtimeMs,
        });
      }
    }
  }

  await visit(sourceDirectory, "");
  return { files, directories };
}

function validateCheckpoint(value: unknown, sourceDirectory: string): UploadCheckpoint {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.sourceDirectory !== sourceDirectory ||
    !isRecord(value.files)
  ) {
    throw new Error("The upload checkpoint is invalid or belongs to a different source directory.");
  }

  const files: Record<string, CheckpointEntry> = {};
  for (const [relativePath, entry] of Object.entries(value.files)) {
    if (
      !isRecord(entry) ||
      typeof entry.fingerprint !== "string" ||
      (entry.status !== "uploaded" && entry.status !== "skipped")
    ) {
      throw new Error(`Invalid checkpoint entry for "${relativePath}".`);
    }
    files[relativePath] = {
      fingerprint: entry.fingerprint,
      status: entry.status,
    };
  }

  return {
    version: 1,
    sourceDirectory,
    files,
  };
}

async function loadCheckpoint(
  statePath: string,
  sourceDirectory: string,
): Promise<UploadCheckpoint> {
  try {
    const contents = await readFile(statePath, "utf8");
    return validateCheckpoint(JSON.parse(contents) as unknown, sourceDirectory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { version: 1, sourceDirectory, files: {} };
    }
    throw new Error(`Could not load upload checkpoint at "${statePath}".`, { cause: error });
  }
}

async function saveCheckpoint(statePath: string, checkpoint: UploadCheckpoint): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(checkpoint, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, statePath);
}

function printProgress(processed: number, total: number, message: string): void {
  const percentage = total === 0 ? 100 : Math.floor((processed / total) * 100);
  console.log(`[${processed}/${total} ${percentage}%] ${message}`);
}

async function createDriveDirectories(
  drive: drive_v3.Drive,
  rootFolderId: string,
  directories: string[],
): Promise<Map<string, string>> {
  const folderIds = new Map<string, string>([["", rootFolderId]]);
  for (const relativePath of directories) {
    if (relativePath === "") {
      continue;
    }

    const parentPath = path.dirname(relativePath);
    const parentId = folderIds.get(parentPath === "." ? "" : parentPath);
    if (!parentId) {
      throw new Error(`Could not find the Drive parent for "${relativePath}".`);
    }
    folderIds.set(
      relativePath,
      await findOrCreateFolder(drive, path.basename(relativePath), parentId),
    );
  }
  return folderIds;
}

async function uploadFiles(
  drive: drive_v3.Drive,
  files: LocalFile[],
  folderIds: Map<string, string>,
  statePath: string,
  checkpoint: UploadCheckpoint,
): Promise<{ uploaded: number; skipped: number; failed: number }> {
  const counts = { uploaded: 0, skipped: 0, failed: 0 };
  let processed = Object.keys(checkpoint.files).length;
  if (processed > 0) {
    printProgress(processed, files.length, `Resuming; ${processed} files already complete`);
  } else if (files.length === 0) {
    printProgress(0, 0, "No files to upload");
  }

  for (const file of files) {
    const fingerprint = getFingerprint(file);
    if (checkpoint.files[file.relativePath]?.fingerprint === fingerprint) {
      continue;
    }

    const relativeDirectory = path.dirname(file.relativePath);
    const driveFolderId = folderIds.get(relativeDirectory === "." ? "" : relativeDirectory);
    if (!driveFolderId) {
      throw new Error(`Could not find the Drive folder for "${file.relativePath}".`);
    }

    let status: CheckpointEntry["status"];
    try {
      if (await fileExists(drive, path.basename(file.relativePath), driveFolderId)) {
        status = "skipped";
      } else {
        await drive.files.create({
          requestBody: {
            name: path.basename(file.relativePath),
            parents: [driveFolderId],
          },
          media: {
            mimeType: "application/octet-stream",
            body: createReadStream(file.absolutePath),
          },
          fields: "id",
        });
        status = "uploaded";
      }
    } catch (error) {
      counts.failed += 1;
      processed += 1;
      printProgress(processed, files.length, `failed; will retry next run: ${file.relativePath}`);
      console.error(`Failed to process "${file.absolutePath}":`, error);
      continue;
    }

    checkpoint.files[file.relativePath] = { fingerprint, status };
    try {
      await saveCheckpoint(statePath, checkpoint);
    } catch (error) {
      delete checkpoint.files[file.relativePath];
      throw new Error(`Could not save checkpoint after processing "${file.relativePath}".`, {
        cause: error,
      });
    }
    counts[status] += 1;
    processed += 1;
    printProgress(processed, files.length, `${status}: ${file.relativePath}`);
  }

  return counts;
}

async function main(): Promise<void> {
  const sourceDirectory = path.resolve(process.argv[2] ?? DEFAULT_SOURCE);
  const credentialsPath = path.resolve(process.env.GOOGLE_DRIVE_CREDENTIALS ?? DEFAULT_CREDENTIALS);
  const tokenPath = path.resolve(process.env.GOOGLE_DRIVE_TOKEN ?? DEFAULT_TOKEN);
  const sourceId = createHash("sha256").update(sourceDirectory).digest("hex").slice(0, 16);
  const statePath = path.resolve(
    process.env.GOOGLE_DRIVE_STATE ??
      path.join(DEFAULT_STATE_DIRECTORY, `upload-${sourceId}.json`),
  );

  const sourceStat = await stat(sourceDirectory);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Source path is not a directory: "${sourceDirectory}".`);
  }

  console.log(`Scanning source: ${sourceDirectory}`);
  const { files, directories } = await collectSourceTree(sourceDirectory);
  const checkpoint = await loadCheckpoint(statePath, sourceDirectory);
  const currentFiles = new Map(
    files.map((file): [string, LocalFile] => [file.relativePath, file]),
  );
  for (const [relativePath, entry] of Object.entries(checkpoint.files)) {
    const currentFile = currentFiles.get(relativePath);
    if (!currentFile || getFingerprint(currentFile) !== entry.fingerprint) {
      delete checkpoint.files[relativePath];
    }
  }
  await saveCheckpoint(statePath, checkpoint);
  console.log(`Found ${files.length} files in ${directories.length} directories.`);
  console.log(`Checkpoint: ${statePath}`);

  const auth = await authorize(credentialsPath, tokenPath);
  const drive = google.drive({ version: "v3", auth });
  const picturesFolderId = await findOrCreateFolder(drive, "Pictures", "root");
  const folderIds = await createDriveDirectories(drive, picturesFolderId, directories);
  const counts = await uploadFiles(drive, files, folderIds, statePath, checkpoint);
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
