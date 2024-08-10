import { error, getInput, info, warning } from "@actions/core";
import fetch from "node-fetch";
import { satisfies } from "semver";
import decompress from "decompress";
import fs from "fs-extra";
import * as path from "path";
import { spawn } from "child_process";

export async function run() {
  const projectInfo = await getProjectInfo(
    getInput("project-path", { required: true }),
    getInput("project-configuration", { required: true }),
  );

  const wantedGameVersion = getInput("game-version") || projectInfo.gameVersion;

  const gameVersions = await fetchJson<string[]>(
    "https://versions.beatmods.com/versions.json",
  );
  const versionAliases = await fetchJson<VersionAliasCollection>(
    "https://alias.beatmods.com/aliases.json",
  );

  const extractPath = getInput("path", { required: true });
  await downloadReferenceAssemblies(wantedGameVersion, extractPath);

  let gameVersion = gameVersions.find(
    (gv) =>
      gv === wantedGameVersion ||
      versionAliases[gv].some((va) => va === wantedGameVersion),
  );
  if (gameVersion == null) {
    const latestVersion = gameVersions[0];
    warning(
      `Game version '${wantedGameVersion}' doesn't exist; using mods from latest version '${latestVersion}'`,
    );
    gameVersion = latestVersion;
  }

  info(`Fetching mods for game version '${gameVersion}'`);
  const mods = await fetchJson<Mod[]>(
    `https://beatmods.com/api/v1/mod?sort=version&sortDirection=-1&gameVersion=${gameVersion}`,
  );

  const depAliases = JSON.parse(getInput("aliases", { required: true }));
  const additionalDependencies = JSON.parse(
    getInput("additional-dependencies", { required: true }),
  );

  for (const [depName, depVersion] of Object.entries({
    ...projectInfo.dependencies,
    ...additionalDependencies,
  })) {
    const dependency = mods.find(
      (m) =>
        (m.name === depName || m.name == depAliases[depName]) &&
        satisfies(m.version, depVersion as string),
    );

    if (dependency == null) {
      warning(`Mod '${depName}' version '${depVersion}' not found.`);
      continue;
    }

    const depDownload = dependency.downloads.find(
      (d) => d.type === "universal",
    )?.url;

    if (!depDownload) {
      warning(`No universal download found for mod '${depName}'`);
      continue;
    }

    info(`Downloading mod '${depName}' version '${dependency.version}'`);
    await downloadAndExtract(`https://beatmods.com${depDownload}`, extractPath);

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

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  return (await response.json()) as T;
}

async function downloadAndExtract(url: string, extractPath: string) {
  const response = await fetch(url);

  if (response.status != 200) {
    throw new Error(
      `Unexpected response status ${response.status} ${response.statusText}`,
    );
  }

  await decompress(Buffer.from(await response.arrayBuffer()), extractPath, {
    // https://github.com/kevva/decompress/issues/46#issuecomment-428018719
    filter: (file) => !file.path.endsWith("/"),
  });
}

async function downloadReferenceAssemblies(
  version: string,
  extractPath: string,
) {
  const accessToken = getInput("access-token", { required: true });
  const url = `https://api.github.com/repos/nicoco007/BeatSaberReferenceAssemblies/zipball/refs/tags/v${version}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "setup-beat-saber",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  info(`Downloading reference assemblies for version '${version}'`);
  const response = await fetch(url, { method: "GET", headers });

  if (response.status != 200) {
    throw new Error(
      `Unexpected response status ${response.status} ${response.statusText}`,
    );
  }

  await decompress(Buffer.from(await response.arrayBuffer()), extractPath, {
    // https://github.com/kevva/decompress/issues/46#issuecomment-428018719
    filter: (file) => !file.path.endsWith("/"),
    map: (file) => {
      if (file.type == "file") {
        file.path = file.path.split("/").slice(2).join(path.sep);
      }

      return file;
    },
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

type VersionAliasCollection = { [key: string]: string[] };

interface Mod {
  name: string;
  version: string;
  downloads: ModDownload[];
}

interface ModDownload {
  type: "universal" | "steam" | "oculus";
  url: string;
}

interface Output {
  Items: { [key: string]: { [key: string]: string }[] };
  Properties: { [key: string]: string };
}

interface ProjectInfo {
  gameVersion: string;
  dependencies: { [key: string]: string };
}
