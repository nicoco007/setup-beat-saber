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
    await fetchJson<GameResponse>(
      "https://beatmods.com/api/v3/games/beatsaber",
    )
  ).gameVersions.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));

  const extractPath = getInput("path", { required: true });
  await downloadReferenceAssemblies(wantedGameVersion, extractPath);

  const gameVersion = gameVersions.find(gv => gv.version === wantedGameVersion);

  if (gameVersion === undefined) {
    warning(
      `Game version '${wantedGameVersion}' doesn't exist on BeatMods. Skipping game version support checks.`,
    );
  }

  info("Fetching mods");
  const projects = (
    await fetchJson<ProjectVersionPair[]>(
      "https://beatmods.com/api/v3/mods?gameName=beatsaber",
    )
  ).map(m => m.project);

  const depAliases = JSON.parse(getInput("aliases", { required: true }));
  const additionalDependencies = JSON.parse(
    getInput("additional-dependencies", { required: true }),
  );

  for (const [depId, depVersion] of Object.entries({
    ...projectInfo.dependencies,
    ...additionalDependencies,
  }) as [string, string][]) {
    // TODO: breaking change - should only be nameId
    const project = projects.find(
      m => m.nameId === depId || m.name === depId || m.name === depAliases[depId],
    );

    if (!project) {
      warning(`Mod '${depId}' does not exist.`);
      continue;
    }

    const versions
      = (
        await fetchJson<ModResponse>(
          `https://beatmods.com/api/v3/mods/${project.id}`,
        )
      )?.versions ?? [];

    const version = versions.filter(v => semver.satisfies(v.semver, depVersion)).sort(
      (a, b) =>
        semver.compare(a.semver, b.semver)
        || supportsGameVersion(gameVersion, b) - supportsGameVersion(gameVersion, a)
        || supportsPriorGameVersion(wantedGameVersion, b) - supportsPriorGameVersion(wantedGameVersion, a),
    )[0];

    if (!version) {
      warning(`No version of ${depId} found that satisfies '${depVersion}'.`);
      continue;
    }

    if (gameVersion !== undefined && !version.supportedGameVersions.find(v => v.id == gameVersion.id)) {
      warning(
        `${depId} ${version.semver} does not support Beat Saber ${gameVersion.version}.`,
      );
    }

    info(`Downloading ${depId} ${version.semver}`);
    await downloadAndExtract(
      version.downloadUrl,
      extractPath,
    );

    // special case since BSIPA moves files when installed with IPA.exe
    if (depId === "BSIPA") {
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
  gameVersion: GameVersion | undefined,
  modVersion: ModVersion,
): number {
  if (!gameVersion) {
    return 0;
  }

  return modVersion.supportedGameVersions.find(gv => gv.id == gameVersion.id)
    ? 1
    : 0;
}

function supportsPriorGameVersion(
  gameVersion: string,
  modVersion: ModVersion,
): number {
  return modVersion.supportedGameVersions.find(
    gv => gv.version.localeCompare(gameVersion, undefined, { numeric: true }) <= 0,
  )
    ? 1
    : 0;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { "User-Agent": "setup-beat-saber" },
  });

  if (!response.ok) {
    throw new Error(
      `Request '${url}' failed: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as T;
}

async function downloadAndExtract(url: string, extractPath: string) {
  const response = await fetch(url, {
    headers: { "User-Agent": "setup-beat-saber" },
  });

  if (!response.ok) {
    throw new Error(
      `Request '${url}' failed: ${response.status} ${response.statusText}`,
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

  info(`Downloading reference assemblies for version '${version}'`);
  const response = await fetch(url, { method: "GET", headers });

  if (!response.ok) {
    throw new Error(
      `Request '${url}' failed: ${response.status} ${response.statusText}`,
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
        reject(new Error(`dotnet returned exit code ${code}. Output:\n${stdout.trim()}\nError\n${stderr.trim()}`));
      }
    });
  });
}

interface GameResponse {
  game: Game;
  gameVersions: GameVersion[];
}

interface Game {
  name: string;
  displayName: string;
}

interface GameVersion {
  id: number;
  gameName: string;
  version: string;
}

interface ProjectVersionPair {
  project: Project;
  version: ModVersion;
}

interface Project {
  id: number;
  name: string;
  nameId: string;
  status: string;
}

interface ModResponse {
  project: Project;
  versions: ModVersion[];
}

interface ModVersion {
  id: number;
  projectId: number;
  semver: string;
  platform: string;
  supportedGameVersions: SupportedGameVersion[];
  downloadUrl: string;
}

interface SupportedGameVersion {
  id: number;
  gameName: string;
  version: string;
}

interface Output {
  Items: { [key: string]: { [key: string]: string }[] };
  Properties: { [key: string]: string };
}

interface ProjectInfo {
  gameVersion: string;
  dependencies: { [key: string]: string };
}
