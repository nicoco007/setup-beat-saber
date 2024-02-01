import { error, getInput, info, warning } from "@actions/core";
import fetch from "node-fetch";
import { satisfies } from "semver";
import decompress from "decompress";
import { readFileSync, writeFileSync } from "fs";
import { copySync } from "fs-extra/esm";
import { join } from "path";

export async function run() {
    const manifestPath = getInput("manifest");
    const extractPath = getInput("path");

    const depAliases = JSON.parse(getInput("aliases") || null) || {};

    if (depAliases != {}) {
        Object.entries(depAliases).forEach(([key, value]) => {
            info(`Given alias '${key}': '${value}'`);
        });
    }

    const additionalDependencies = JSON.parse(getInput("additional-dependencies") || null) || {};

    if (additionalDependencies != {}) {
        Object.entries(additionalDependencies).forEach(([key, value]) => {
            info(`Given additional dependency '${key}' @ '${value}'`);
        });
    }

    let manifestStringData = readFileSync(manifestPath, "utf8");
    if (manifestStringData.startsWith("\uFEFF")) {
        warning("BOM character detected at the beginning of the manifest JSON file. Please remove the BOM from the file as it does not conform to the JSON spec (https://datatracker.ietf.org/doc/html/rfc7159#section-8.1) and may cause issues regarding interoperability.")
        manifestStringData = manifestStringData.slice(1);
    }

    const manifest = JSON.parse(manifestStringData);
    info(`Retrieved manifest of '${manifest.id}' version '${manifest.version}'`);

    const semverRegex = /^(?<prerelease>(?<version>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-(?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?)(?:\+(?:[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
    const match = semverRegex.exec(manifest.version);

    const versionWithPrerelease = match.groups["prerelease"];

    if (process.env["GITHUB_REF_TYPE"] == "tag") {
        const gitTag = process.env["GITHUB_REF_NAME"];
        const tagFormat = getInput("tag-format") || "v{0}";
        const builtTag = tagFormat.replace("{0}", versionWithPrerelease);

        if (gitTag != builtTag) {
            throw new Error(`Git tag '${gitTag}' does not match manifest version '${builtTag}'`);
        }

        info(`Using Git tag '${gitTag}'`);
        manifest.version = versionWithPrerelease;
    } else {
        const hash = process.env["GITHUB_SHA"];
        info(`Using Git hash '${hash}'`);
        manifest.version = `${versionWithPrerelease}+git.${hash}`;
    }

    writeFileSync(manifestPath, JSON.stringify(manifest, null, 4), { encoding: "utf8" });

    const wantedGameVersion = getInput("game-version") || manifest.gameVersion;
    await downloadBindings(wantedGameVersion, extractPath);

    const gameVersions = await fetchJson("https://versions.beatmods.com/versions.json");
    const versionAliases = await fetchJson("https://alias.beatmods.com/aliases.json");

    const version = gameVersions.find(x => x === wantedGameVersion || versionAliases[x].some(y => y === wantedGameVersion));
    if (version == null) {
        throw new Error(`Game version '${wantedGameVersion}' doesn't exist.`);
    }

    info(`Fetching mods for game version '${version}'`);
    const mods = await fetchJson(`https://beatmods.com/api/v1/mod?sort=version&sortDirection=-1&gameVersion=${version}`);

    for (const [depName, depVersion] of Object.entries({ ...manifest.dependsOn, ...additionalDependencies })) {
        const dependency = mods.find(x => (x.name === depName || x.name == depAliases[depName]) && satisfies(x.version, depVersion));

        if (dependency != null) {
            const depDownload = dependency.downloads.find(x => x.type === "universal").url;
            info(`Downloading mod '${depName}' version '${dependency.version}'`);
            await download(`https://beatmods.com${depDownload}`, extractPath);

            // special case since BSIPA moves files at runtime
            if (depName === "BSIPA") {
                copySync(join(extractPath, "IPA", "Libs"), join(extractPath, "Libs"), { overwrite: true });
                copySync(join(extractPath, "IPA", "Data"), join(extractPath, "Beat Saber_Data"), { overwrite: true });
            }
        } else {
            error(`Mod '${depName}' version '${depVersion}' not found.`);
        }
    }
}

async function fetchJson(url) {
    const response = await fetch(url);
    return await response.json();
}

async function download(url, extractPath) {
    const response = await fetch(url);
    await decompress(Buffer.from(await response.arrayBuffer()), extractPath);
}

async function downloadBindings(version, extractPath) {
    const accessToken = getInput("access-token");
    const url = `https://api.github.com/repos/nicoco007/BeatSaberBindings/zipball/refs/tags/v${version}`
    const headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": "setup-beat-saber",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    info(`Downloading bindings for version '${version}'`);
    const response = await fetch(url, { method: "GET", headers });

    if (response.status != 200) {
        throw new Error(`Unexpected response status ${response.status} ${response.statusText}`);
    }

    await decompress(
        Buffer.from(await response.arrayBuffer()),
        join(extractPath, "Beat Saber_Data", "Managed"),
        {
            map: (file) => {
                if (file.type == "file") {
                    file.path = file.path.substring(file.path.indexOf("/") + 1);
                }

                return file;
            },
        });
}