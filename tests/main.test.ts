import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import * as process from "process";
import * as path from "path";
import sinon from "sinon";
import * as nf from "node-fetch";
import * as ac from "@actions/core";
import fs from "fs-extra";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fetch = sinon.stub().callsFake((url) => { throw new Error(`Unexpected web request to ${url}`) });

jest.unstable_mockModule("node-fetch", () => ({
    ...nf,
    __esModule: true,
    default: fetch,
}));

jest.unstable_mockModule("@actions/core", () => ({
    ...ac,
    __esModule: true,
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
}));

const readFileSync = sinon.stub();
const writeFileSync = jest.fn();

jest.mock('fs-extra', () => ({
    ...fs,
    readFileSync: readFileSync,
    writeFileSync: writeFileSync,
}));

const { run } = await import("../src/main");
const core = await import("@actions/core");

function setInput(name: string, value: string) {
    process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] = value;
}

function mockFetch(url: string, body: nf.BodyInit | undefined, status = 200) {
    fetch.withArgs(url).returns(new nf.Response(body, {
        status: status,
        headers: new nf.Headers({
            "Content-Type": "application/json",
        }),
    }));
}

function mockGitHubApiResponse(response: nf.Response | undefined = undefined) {
    response ||= new nf.Response(
        fs.createReadStream(path.join(__dirname, "files", "beat-saber-bindings.zip")),
        {
            status: 200,
            headers: new nf.Headers({ "Content-Type": "application/octet-stream" }),
        }
    );
    
    fetch.withArgs(
        sinon.match(new RegExp("https://api.github.com/repos/nicoco007/BeatSaberBindings/zipball/refs/tags/v.*")),
        {
            method: 'GET',
            headers: {
                "Accept": "application/vnd.github+json",
                "Authorization": `Bearer github_pat_whatever`,
                "User-Agent": "setup-beat-saber",
                "X-GitHub-Api-Version": "2022-11-28",
            }
        }
    ).callsFake(() => response);
}

interface Manifest {
    id: string;
    version: string;
    gameVersion: string;
    dependsOn: { [key: string]: string };
}

function mockManifest({
    id = "examplemod",
    version = "0.1.0",
    gameVersion = "1.13.2",
    dependsOn = {
        "BSIPA": "^4.1.3",
        "BS Utils": "^1.6.3",
        "SongCore": "^3.0.2"
    },
}: Partial<Manifest> = {}, bom = false): Manifest {
    const manifest = {
        id,
        version,
        gameVersion,
        dependsOn,
    };

    readFileSync.withArgs("manifest.json").returns((bom ? "\uFEFF" : "") + JSON.stringify(manifest));

    return manifest;
}

describe("main", () => {
    const env = { ...process.env };
    let manifest: Manifest;

    beforeEach(() => {
        setInput("path", path.join(__dirname, "BeatSaberBindings"));
        setInput("access-token", "github_pat_whatever");
        setInput("manifest", "manifest.json");

        process.env["GITHUB_SHA"] = "4ef156d43d79b5b63b421f7e867ff67d57ee42d8";

        manifest = mockManifest();

        fetch.withArgs(sinon.match(new RegExp("https://beatmods.com/uploads/.*"))).callsFake(() =>
            new nf.Response(
                fs.createReadStream(path.join(__dirname, "files", "dummy.zip")),
                {
                    status: 200,
                    headers: new nf.Headers({ "Content-Type": "application/octet-stream" }),
                }
            )
        );

        mockGitHubApiResponse();

        mockFetch("https://versions.beatmods.com/versions.json", JSON.stringify(["1.16.1", "1.13.2"]));
        mockFetch("https://alias.beatmods.com/aliases.json", JSON.stringify({ "1.13.2": [], "1.16.1": ["1.16.2"] }));
        mockFetch("https://beatmods.com/api/v1/mod?sort=version&sortDirection=-1&gameVersion=1.13.2", fs.readFileSync(path.join(__dirname, "files", "mods_1.13.2.json")));
        mockFetch("https://beatmods.com/api/v1/mod?sort=version&sortDirection=-1&gameVersion=1.16.1", fs.readFileSync(path.join(__dirname, "files", "mods_1.16.1.json")));
    });

    it("downloads bindings", async () => {
        await run();

        expect(fs.existsSync(path.join(__dirname, "BeatSaberBindings", "Beat Saber_Data", "Managed", "Main.dll"))).toBe(true);
    });

    it("throws an error if the response code isn't 200", async () => {
        mockGitHubApiResponse(new nf.Response(null, { status: 404, statusText: "Not Found" }));

        await expect(run()).rejects.toThrow(new Error("Unexpected response status 404 Not Found"));
    });

    it("throws if bindings response isn't successful", async () => {
        mockGitHubApiResponse(new nf.Response(null, { status: 401, statusText: "Unauthorized" }));

        await expect(run()).rejects.toThrow("Unexpected response status 401 Unauthorized");
    });

    it("injects the git hash into the manifest version", async () => {
        await run();

        manifest.version = "0.1.0+git.4ef156d43d79b5b63b421f7e867ff67d57ee42d8"

        expect(core.info).toHaveBeenCalledWith("Using Git hash '4ef156d43d79b5b63b421f7e867ff67d57ee42d8'");
        expect(writeFileSync).toHaveBeenCalledWith("manifest.json", JSON.stringify(manifest, null, 4), { encoding: 'utf8' });
    });

    it("validates the tag if present", async () => {
        process.env["GITHUB_REF_TYPE"] = "tag";
        process.env["GITHUB_REF_NAME"] = "v0.1.0";

        await run();

        expect(core.info).toHaveBeenCalledWith("Using Git tag 'v0.1.0'");
        expect(writeFileSync).toHaveBeenCalledWith("manifest.json", JSON.stringify(manifest, null, 4), { encoding: 'utf8' });
    });

    it("validates the tag if present with a custom tag format", async () => {
        setInput("tag-format", "some-thing/v{0}");
        process.env["GITHUB_REF_TYPE"] = "tag";
        process.env["GITHUB_REF_NAME"] = "some-thing/v0.1.0";

        await run();

        expect(core.info).toHaveBeenCalledWith("Using Git tag 'some-thing/v0.1.0'");
        expect(writeFileSync).toHaveBeenCalledWith("manifest.json", JSON.stringify(manifest, null, 4), { encoding: 'utf8' });
    });

    it("fails if the tag does not match the manifest version", async () => {
        process.env["GITHUB_REF_TYPE"] = "tag";
        process.env["GITHUB_REF_NAME"] = "v1.0.0";

        await expect(run()).rejects.toThrow("Git tag 'v1.0.0' does not match manifest version 'v0.1.0'");
    });

    it("downloads all mods listed in manifest", async () => {
        await run();

        // this sucks but I'm too lazy to make it better
        expect(core.info).toHaveBeenCalledWith("Retrieved manifest of 'examplemod' version '0.1.0'");
        expect(core.info).toHaveBeenCalledWith("Fetching mods for game version '1.13.2'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'BSIPA' version '4.1.4'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'BS Utils' version '1.7.0'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'SongCore' version '3.1.0'");
    });

    it("resolves version aliases", async () => {
        mockManifest({ gameVersion: "1.16.2" })

        await run();

        expect(fetch).toHaveBeenCalledWith("https://api.github.com/repos/nicoco007/BeatSaberBindings/zipball/refs/tags/v1.16.2");

        expect(core.info).toHaveBeenCalledWith("Retrieved manifest of 'examplemod' version '0.1.0'");
        expect(core.info).toHaveBeenCalledWith("Fetching mods for game version '1.16.1'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'BSIPA' version '4.1.6'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'SongCore' version '3.5.0'");
    });

    it("resolves mod aliases", async () => {
        setInput("aliases", JSON.stringify({ "CustomAvatar": "Custom Avatars" }));
        mockManifest({ dependsOn: { "CustomAvatar": "5.1.2" } });

        await run();

        expect(core.info).toHaveBeenCalledWith("Retrieved manifest of 'examplemod' version '0.1.0'");
        expect(core.info).toHaveBeenCalledWith("Fetching mods for game version '1.13.2'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'CustomAvatar' version '5.1.2'");
    });

    it("downloads additional dependencies", async () => {
        setInput("additional-dependencies", JSON.stringify({ "Custom Avatars": "^5.1.0" }));

        await run();

        expect(core.info).toHaveBeenCalledWith("Retrieved manifest of 'examplemod' version '0.1.0'");
        expect(core.info).toHaveBeenCalledWith("Fetching mods for game version '1.13.2'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'BSIPA' version '4.1.4'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'BS Utils' version '1.7.0'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'SongCore' version '3.1.0'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'Custom Avatars' version '5.1.2'");
    });

    it("warns if game version doesn't exist and falls back to latest version", async () => {
        mockManifest({ gameVersion: "1.2.3" });

        await run();

        expect(core.warning).toHaveBeenCalledWith("Game version '1.2.3' doesn't exist; using latest version '1.16.1'");
        expect(fetch).toHaveBeenCalledWith("https://beatmods.com/api/v1/mod?sort=version&sortDirection=-1&gameVersion=1.16.1")
    });

    it("logs error for missing mods", async () => {
        mockManifest({ dependsOn: { "MissingMod": "^1.0.0" } })

        await run();

        expect(core.error).toHaveBeenCalledWith("Mod 'MissingMod' version '^1.0.0' not found.");
    });

    it("logs error for missing versions", async () => {
        mockManifest({ dependsOn: { "BeatSaverSharp": "^2000.0.0" } });

        await run();

        expect(core.error).toHaveBeenCalledWith("Mod 'BeatSaverSharp' version '^2000.0.0' not found.");
    });

    it("warns if manifest has a BOM", async () => {
        mockManifest({}, true);

        await run();

        expect(core.warning).toHaveBeenCalledWith("BOM character detected at the beginning of the manifest JSON file. Please remove the BOM from the file as it does not conform to the JSON spec (https://datatracker.ietf.org/doc/html/rfc7159#section-8.1) and may cause issues regarding interoperability.");
    });

    afterEach(() => {
        fs.rmSync(path.join(__dirname, "BeatSaberBindings"), { recursive: true, force: true });
        sinon.restore();
        jest.resetAllMocks();

        for (const key in process.env) {
            const val = env[key];

            if (val) {
                process.env[key] = val;
            } else {
                delete process.env[key];
            }
        }
    });
});
