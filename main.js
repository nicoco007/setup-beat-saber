import { info, getInput, warning, setFailed } from '@actions/core';
import fetch from 'node-fetch';
import { satisfies } from 'semver';
import { Extract } from 'unzipper';
import { readFileSync } from "fs";
import { copySync } from "fs-extra/esm";
import { join } from "path";

main().then(() => info("Complete!"))

async function main() {
    try {
        const manifestPath = getInput("manifest");
        const extractPath = getInput("path");
        const rawAliases = getInput("aliases");

        const depAliases = JSON.parse(rawAliases);

        if (depAliases != {}) {
            const aliasKeys = Object.keys(depAliases);
            aliasKeys.forEach(key => {
                info(`Given alias '${key}': '${depAliases[key]}'`);
            });
        }

        let manifestStringData = readFileSync(manifestPath, 'utf8');
        if (manifestStringData.startsWith('\uFEFF')) {
            warning("BOM character detected at the beginning of the manifest JSON file. Please remove the BOM from the file as it does not conform to the JSON spec (https://datatracker.ietf.org/doc/html/rfc7159#section-8.1) and may cause issues regarding interoperability.")
            manifestStringData = manifestStringData.slice(1);
        }

        const manifest = JSON.parse(manifestStringData);
        info("Retrieved manifest of '" + manifest.id + "' version '" + manifest.version + "'");

        const gameVersions = await fetchJson("https://versions.beatmods.com/versions.json");
        const versionAliases = await fetchJson("https://alias.beatmods.com/aliases.json");

        const version = gameVersions.find(x => x === manifest.gameVersion || versionAliases[x].some(y => y === manifest.gameVersion));
        if (version == null) {
            throw new Error("Game version '" + manifest.gameVersion + "' doesn't exist.");
        }

        info("Fetching mods for game version '" + version + "'");
        const mods = await fetchJson("https://beatmods.com/api/v1/mod?sort=version&sortDirection=-1&gameVersion=" + version);

        for (let depName of Object.keys(manifest.dependsOn)) {
            const depVersion = manifest.dependsOn[depName];
            const dependency = mods.find(x => (x.name === depName || x.name == depAliases[depName]) && satisfies(x.version, depVersion));

            if (dependency != null) {
                const depDownload = dependency.downloads.find(x => x.type === "universal").url;
                info("Downloading mod '" + depName + "' version '" + dependency.version + "'");
                await download("https://beatmods.com" + depDownload, extractPath);

                // special case since BSIPA moves files at runtime
                if (depName === "BSIPA") {
                    copySync(join(extractPath, "IPA", "Libs"), join(extractPath, "Libs"), { overwrite: true });
                    copySync(join(extractPath, "IPA", "Data"), join(extractPath, "Beat Saber_Data"), { overwrite: true });
                }
            } else {
                warning("Mod '" + depName + "' version '" + depVersion + "' not found.");
            }
        }
    } catch (error) {
        setFailed(error.message);
    }
}

async function fetchJson(url) {
    const response = await fetch(url);
    return await response.json();
}

async function download(url, extractPath) {
    const response = await fetch(url);
    const stream = Extract({path: extractPath});
    const promise = new Promise((resolve) => {
        stream.on('finish', () => {
            resolve();
        });
    });
    
    response.body.pipe(stream);

    return promise;
}