import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import * as process from "process";
import * as path from "path";
import sinon from "sinon";
import * as nf from "node-fetch";
import { readFileSync, createReadStream, rmSync } from "fs";
import * as ac from "@actions/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

jest.unstable_mockModule("node-fetch", () => ({
    ...nf,
    __esModule: true,
    default: sinon.stub(),
}));

jest.unstable_mockModule("@actions/core", async () => ({
    ...ac,
    __esModule: true,
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
}))

const { default: fetch } = await import("node-fetch");
const { main } = await import("./main");
const core = await import ("@actions/core");

function mockFetch(url, body, status = 200) {
    fetch.withArgs(url).returns(new nf.Response(body, {
        status: status,
        headers: new nf.Headers({
            "Content-Type": "application/json",
        }),
    }));
}

describe("main", () => {
    beforeEach(() => {
        delete process.env["INPUT_MANIFEST"];
        delete process.env["INPUT_PATH"];
        delete process.env["INPUT_ALIASES"];
        delete process.env["INPUT_ADDITIONAL-DEPENDENCIES"];

        fetch.withArgs(sinon.match(/https:\/\/beatmods.com\/uploads\/.*/)).callsFake(() =>
            new nf.Response(
                createReadStream(path.join(__dirname, "tests", "dummy.zip")),
                {
                    status: 200,
                    headers: new nf.Headers({ "Content-Type": "application/octet-stream" })
                }
            )
        );

        mockFetch("https://versions.beatmods.com/versions.json", JSON.stringify(["1.13.2", "1.16.1"]));
        mockFetch("https://alias.beatmods.com/aliases.json", JSON.stringify({ "1.13.2": [], "1.16.1": ["1.16.2"] }));
        mockFetch("https://beatmods.com/api/v1/mod?sort=version&sortDirection=-1&gameVersion=1.13.2", readFileSync(path.join(__dirname, "tests", "mods_1.13.2.json")));
        mockFetch("https://beatmods.com/api/v1/mod?sort=version&sortDirection=-1&gameVersion=1.16.1", readFileSync(path.join(__dirname, "tests", "mods_1.16.1.json")));
    });

    test("downloads all mods listed in manifest", async () => {
        process.env["INPUT_MANIFEST"] = path.join(__dirname, "tests", "basic.json");
        process.env["INPUT_PATH"] = path.join(__dirname, "Refs");

        await main();

        // this sucks but I'm too lazy to make it better
        expect(core.info).toHaveBeenCalledWith("Retrieved manifest of 'examplemod' version '0.1.0'");
        expect(core.info).toHaveBeenCalledWith("Fetching mods for game version '1.13.2'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'BSIPA' version '4.1.4'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'BS Utils' version '1.7.0'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'SongCore' version '3.1.0'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'BeatSaverSharp' version '2.0.0'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'BeatSaberMarkupLanguage' version '1.4.5'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'SiraUtil' version '2.5.1'");
    });

    test("resolves version aliases", async () => {
        process.env["INPUT_MANIFEST"] = path.join(__dirname, "tests", "version_alias.json");
        process.env["INPUT_PATH"] = path.join(__dirname, "Refs");

        await main();

        expect(core.info).toHaveBeenCalledWith("Retrieved manifest of 'examplemod' version '0.1.0'");
        expect(core.info).toHaveBeenCalledWith("Fetching mods for game version '1.16.1'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'BSIPA' version '4.1.6'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'SongCore' version '3.5.0'");
    });

    test("resolves mod aliases", async () => {
        process.env["INPUT_MANIFEST"] = path.join(__dirname, "tests", "mod_alias.json");
        process.env["INPUT_PATH"] = path.join(__dirname, "Refs");
        process.env["INPUT_ALIASES"] = JSON.stringify({ "CustomAvatar": "Custom Avatars" });

        await main();

        expect(core.info).toHaveBeenCalledWith("Given alias 'CustomAvatar': 'Custom Avatars'");
        expect(core.info).toHaveBeenCalledWith("Retrieved manifest of 'examplemod' version '0.1.0'");
        expect(core.info).toHaveBeenCalledWith("Fetching mods for game version '1.13.2'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'CustomAvatar' version '5.1.2'");
    });

    test("downloads additional dependencies", async () => {
        process.env["INPUT_MANIFEST"] = path.join(__dirname, "tests", "basic.json");
        process.env["INPUT_PATH"] = path.join(__dirname, "Refs");
        process.env["INPUT_ADDITIONAL-DEPENDENCIES"] = JSON.stringify({ "Custom Avatars": "^5.1.0" });

        await main();

        expect(core.info).toHaveBeenCalledWith("Retrieved manifest of 'examplemod' version '0.1.0'");
        expect(core.info).toHaveBeenCalledWith("Fetching mods for game version '1.13.2'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'BSIPA' version '4.1.4'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'BS Utils' version '1.7.0'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'SongCore' version '3.1.0'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'BeatSaverSharp' version '2.0.0'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'BeatSaberMarkupLanguage' version '1.4.5'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'SiraUtil' version '2.5.1'");
        expect(core.info).toHaveBeenCalledWith("Downloading mod 'Custom Avatars' version '5.1.2'");
    });

    test("logs error for missing mods", async () => {
        process.env["INPUT_MANIFEST"] = path.join(__dirname, "tests", "nonexistent_mod.json");
        process.env["INPUT_PATH"] = path.join(__dirname, "Refs");

        await expect(main())
            .rejects
            .toThrow("Specified mods could not be downloaded.");

        expect(core.error).toHaveBeenCalledWith("Mod 'MissingMod' version '^1.0.0' not found.");
    });

    test("logs error for missing versions", async () => {
        process.env["INPUT_MANIFEST"] = path.join(__dirname, "tests", "nonexistent_version.json");
        process.env["INPUT_PATH"] = path.join(__dirname, "Refs");

        await expect(main())
            .rejects
            .toThrow("Specified mods could not be downloaded.");

        expect(core.error).toHaveBeenCalledWith("Mod 'BeatSaverSharp' version '^2000.0.0' not found.");
    });

    test("warns if manifest has a BOM", async () => {
        process.env["INPUT_MANIFEST"] = path.join(__dirname, "tests", "with_bom.json");
        process.env["INPUT_PATH"] = path.join(__dirname, "Refs");

        await main();

        expect(core.warning).toHaveBeenCalledWith("BOM character detected at the beginning of the manifest JSON file. Please remove the BOM from the file as it does not conform to the JSON spec (https://datatracker.ietf.org/doc/html/rfc7159#section-8.1) and may cause issues regarding interoperability.");
    });

    afterEach(() => {
        rmSync(path.join(__dirname, "Refs"), { recursive: true, force: true });
        sinon.restore();
        jest.resetAllMocks();
    })
});
