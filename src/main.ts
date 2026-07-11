import { getInput, info, warning } from "@actions/core";
import { fetch } from "undici";
import * as semver from "semver";
import { unzip } from "fflate";
import fs from "fs-extra";
import * as path from "path";
import { spawn } from "child_process";

export async function run() {
  const projectInfo = await getProjectInfo(
    getInput("project-path", { required: true }),
    getInput("project-configuration", { required: true }),
  );

  const wantedGameVersion = getInput("game-version") || projectInfo.gameVersion;

  const gameVersions = (
    await fetchJson<VersionsResponse>(
      "https://beatmods.com/api/versions?gameName=BeatSaber",
    )
  ).versions;

  const extractPath = getInput("path", { required: true });
  await downloadReferenceAssemblies(wantedGameVersion, extractPath);

  let gameVersion = gameVersions.find(gv => gv.version === wantedGameVersion);

  if (gameVersion == null) {
    gameVersion = gameVersions.find(v => v.defaultVersion) || gameVersions[0];
    warning(
      `Game version '${wantedGameVersion}' doesn't exist; using mods from latest version '${gameVersion.version}'`,
    );
  }

  info("Fetching mods");
  const mods = (
    await fetchJson<ModsResponse>(
      "https://beatmods.com/api/mods?gameName=BeatSaber&status=all",
    )
  ).mods;

  const depAliases = JSON.parse(getInput("aliases", { required: true }));
  const additionalDependencies = JSON.parse(
    getInput("additional-dependencies", { required: true }),
  );

  for (const [depName, depVersion] of Object.entries({
    ...projectInfo.dependencies,
    ...additionalDependencies,
  }) as [string, string][]) {
    const mod = mods.find(
      m => m.mod.name === depName || m.mod.name == depAliases[depName],
    );

    if (!mod) {
      warning(`Mod '${depName}' does not exist.`);
      continue;
    }

    const versions
      = (
        await fetchJson<ModResponse>(
          `https://beatmods.com/api/mods/${mod.mod.id}`,
        )
      )?.mod?.versions?.sort(
        (a, b) =>
          semver.compare(a.modVersion, b.modVersion)
          || supportsGameVersion(gameVersion, b) - supportsGameVersion(gameVersion, a)
          || supportsPriorGameVersion(gameVersion, b) - supportsPriorGameVersion(gameVersion, a),
      ) ?? [];

    const version = versions.find(v =>
      semver.satisfies(v.modVersion, depVersion),
    );

    if (!version) {
      warning(`No version of ${depName} found that satisfies '${depVersion}'.`);
      continue;
    }

    if (!version.supportedGameVersions.find(v => v.id == gameVersion.id)) {
      warning(
        `${depName} ${version.modVersion} does not support Beat Saber ${gameVersion.version}.`,
      );
    }

    info(`Downloading ${depName} ${version.modVersion}`);
    await downloadAndExtract(
      `https://beatmods.com/cdn/mod/${version.zipHash}.zip`,
      extractPath,
    );

    // special case since BSIPA moves files when installed with IPA.exe
    if (depName === "BSIPA") {
      fs.copySync(
        path.join(extractPath, "IPA", "Libs"),
        path.join(extractPath, "Libs"),
        {
          overwrite: true,
        },
      );
      fs.copySync(
        path.join(extractPath, "IPA", "Data"),
        path.join(extractPath, "Beat Saber_Data"),
      );
    }
  }

  fs.appendFileSync(
    process.env["GITHUB_ENV"]!,
    `BeatSaberDir=${extractPath}\nGameDirectory=${extractPath}\n`,
    "utf8",
  );
}

function supportsGameVersion(
  gameVersion: Version,
  modVersion: ModVersion,
): number {
  return modVersion.supportedGameVersions.find(gv => gv.id == gameVersion.id)
    ? 1
    : 0;
}

function supportsPriorGameVersion(
  gameVersion: Version,
  modVersion: ModVersion,
): number {
  return modVersion.supportedGameVersions.find(
    gv => gv.version <= gameVersion.version,
  )
    ? 1
    : 0;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { "User-Agent": "setup-beat-saber" },
  });
  return (await response.json()) as T;
}

async function downloadAndExtract(url: string, extractPath: string) {
  const response = await fetch(url, {
    headers: { "User-Agent": "setup-beat-saber" },
  });

  if (response.status != 200) {
    throw new Error(
      `Unexpected response status ${response.status} ${response.statusText}`,
    );
  }

  const files = await unzipAsync(Buffer.from(await response.arrayBuffer()));
  for (const [filePath, data] of Object.entries(files)) {
    if (filePath.endsWith("/")) continue;
    const destPath = path.join(extractPath, filePath);
    await fs.ensureDir(path.dirname(destPath));
    await fs.writeFile(destPath, data);
  }
}

async function downloadReferenceAssemblies(
  version: string,
  extractPath: string,
) {
  const url = `https://api.github.com/repos/nicoco007/BeatSaberReferenceAssemblies/zipball/refs/tags/v${version}`;
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "setup-beat-saber",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const accessToken = getInput("access-token", { required: false });
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  info(`Downloading reference assemblies for version '${version}'`);
  const response = await fetch(url, { method: "GET", headers });

  if (response.status != 200) {
    throw new Error(
      `Unexpected response status ${response.status} ${response.statusText}`,
    );
  }

  const files = await unzipAsync(Buffer.from(await response.arrayBuffer()));
  for (const [filePath, data] of Object.entries(files)) {
    if (filePath.endsWith("/")) continue;
    const destRelPath = filePath.split("/").slice(2).join(path.sep);
    if (!destRelPath) continue;
    const destPath = path.join(extractPath, destRelPath);
    await fs.ensureDir(path.dirname(destPath));
    await fs.writeFile(destPath, data);
  }
}

function unzipAsync(data: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(data, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

async function getProjectInfo(
  projectPath: string,
  configuration: string,
): Promise<ProjectInfo> {
  return new Promise<ProjectInfo>((resolve, reject) => {
    const proc = spawn("dotnet", [
      "build",
      projectPath,
      "-c",
      configuration,
      "-getProperty:GameVersion",
      "-getItem:DependsOn",
    ]);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: string) => {
      stdout += data;
    });

    proc.stderr.on("data", (data: string) => {
      stderr += data;
    });

    proc.on("close", (code) => {
      if (code === 0) {
        try {
          const data = JSON.parse(stdout.trim()) as Output;
          resolve({
            gameVersion: data["Properties"]["GameVersion"]!,
            dependencies: data["Items"]["DependsOn"].reduce(
              (
                obj: { [key: string]: string },
                d: { [key: string]: string },
              ) => {
                obj[d["Identity"]] = d["Version"];
                return obj;
              },
              {},
            ),
          });
        } catch (err) {
          reject(err);
        }
      } else {
        reject(new Error(stderr.trim()));
      }
    });
  });
}

interface VersionsResponse {
  versions: Version[];
}

interface Version {
  linkedVersionIds: number[];
  id: number;
  gameName: string;
  version: string;
  defaultVersion: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface ModsResponse {
  mods: ModLatestVersion[];
}

interface ModResponse {
  mod: {
    info: Mod;
    versions: ModVersion[];
  };
}

interface ModLatestVersion {
  mod: Mod;
  latest: ModVersion;
}

interface Mod {
  id: number;
  name: string;
}

interface ModVersion {
  id: number;
  modId: number;
  modVersion: string;
  platform: string;
  supportedGameVersions: SupportedGameVersion[];
  zipHash: string;
}

interface SupportedGameVersion {
  id: number;
  gameName: string;
  version: string;
  defaultVersion: boolean;
}

interface Output {
  Items: { [key: string]: { [key: string]: string }[] };
  Properties: { [key: string]: string };
}

interface ProjectInfo {
  gameVersion: string;
  dependencies: { [key: string]: string };
}
