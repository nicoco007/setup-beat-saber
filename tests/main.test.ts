import assert from "assert/strict";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import * as child_process from "child_process";
import { EventEmitter } from "events";
import { Readable } from "stream";
import sinon from "sinon";
import path from "path";
import { fileURLToPath } from "url";

import undici from "undici";
import { readFile, rm } from "fs/promises";
import { existsSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const childProcessSpawn = sinon.stub();
const infoMock = sinon.stub();
const warningMock = sinon.stub();

function assertFileExists(path: string): void {
  if (!existsSync(path)) {
    throw new assert.AssertionError({ message: `File '${path}' does not exist` });
  }
}

export function mockProcess(
  path: string,
  args: string[] | sinon.SinonMatcher = sinon.match.any,
  stdout: string | undefined = undefined,
  stderr: string | undefined = undefined,
  exitCode: number = 0,
) {
  const proc = new EventEmitter() as child_process.ChildProcessWithoutNullStreams;
  proc.stdout = new EventEmitter() as Readable;
  proc.stderr = new EventEmitter() as Readable;

  childProcessSpawn
    .withArgs(path, args)
    .callsFake(() => {
      process.nextTick(() => {
        if (stdout) {
          proc.stdout.emit("data", stdout);
        }

        if (stderr) {
          proc.stderr.emit("data", stderr);
        }

        process.nextTick(() => {
          proc.emit("close", exitCode);
        });
      });

      return proc;
    });
}

function mockProject({
  gameVersion = "1.13.2",
  dependsOn = {
    "BSIPA": "^4.1.3",
    "BS Utils": "^1.6.3",
  },
}: { gameVersion?: string; dependsOn?: { [key: string]: string } } = {}) {
  mockProcess(
    "dotnet",
    sinon.match.any,
    JSON.stringify({
      Properties: {
        GameVersion: gameVersion,
      },
      Items: {
        DependsOn: Object.entries(dependsOn).map(([key, value]) => ({
          Identity: key,
          Version: value,
        })),
      },
    }),
  );
}

function setInput(name: string, value: string) {
  process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] = value;
}

describe("main", () => {
  const env = { ...process.env };

  const GITHUB_ENV_FILE = "github_env.txt";
  const OUTPUT_DIRECTORY = path.join(__dirname, "BeatSaberReferenceAssemblies");

  const BEATMODS_HEADERS = {
    "User-Agent": "setup-beat-saber",
  };

  const GITHUB_HEADERS = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "setup-beat-saber",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  let run: () => Promise<void>;
  let agent: undici.MockAgent;
  let beatmods: undici.Interceptable;
  let github: undici.Interceptable;

  before(async () => {
    mock.module("child_process", {
      namedExports: {
        ...await import("child_process"),
        spawn: childProcessSpawn,
      },
    });

    mock.module("@actions/core", {
      namedExports: {
        ...await import("@actions/core"),
        info: infoMock,
        warning: warningMock,
      },
    });

    ({ run } = await import("../src/main.js"));
  });

  beforeEach(async () => {
    setInput("path", OUTPUT_DIRECTORY);
    setInput("project-path", path.join(__dirname, "Project", "Project.csproj"));
    setInput("project-configuration", "Release");
    setInput("aliases", "{}");
    setInput("additional-dependencies", "{}");

    process.env["GITHUB_ENV"] = path.join(__dirname, GITHUB_ENV_FILE);
    process.env["GITHUB_SHA"] = "4ef156d43d79b5b63b421f7e867ff67d57ee42d8";

    agent = new undici.MockAgent({ enableCallHistory: true });
    agent.disableNetConnect();
    undici.setGlobalDispatcher(agent);

    beatmods = agent.get("https://beatmods.com");
    github = agent.get("https://api.github.com");
  });

  async function mockRequests() {
    mockVersionsRequest();
    mockModsRequest();
    await mockModsRequests();
    await mockDownloadRequests();
    await mockGitHubRequest();
  }

  function mockVersionsRequest() {
    beatmods.intercept({ method: "GET", path: "/api/versions?gameName=BeatSaber", headers: BEATMODS_HEADERS }).reply(200, JSON.stringify({
      versions: [
        { id: 1, version: "1.13.2", defaultVersion: true },
        { id: 2, version: "1.16.1", defaultVersion: false },
        { id: 3, version: "1.13.1", defaultVersion: false },
        { id: 4, version: "1.13.3", defaultVersion: false },
      ],
    }));
  }

  function mockModsRequest() {
    beatmods.intercept({ method: "GET", path: "/api/mods?gameName=BeatSaber&status=all", headers: BEATMODS_HEADERS }).reply(200, JSON.stringify({
      mods: [
        {
          mod: { id: 1, name: "BSIPA" },
          latest: {
            modVersion: "4.1.6",
            zipHash: "226190d94b21d1b0c7b1a42d855e419d",
            supportedGameVersions: [{ id: 2 }],
          },
        },
        {
          mod: { id: 2, name: "BS Utils" },
          latest: {
            modVersion: "1.10.0",
            zipHash: "12199c32158fe94fda292d083dba4ef3",
            supportedGameVersions: [{ id: 2 }],
          },
        },
      ],
    }));
  }

  async function mockModsRequests() {
    beatmods.intercept({ method: "GET", path: "/api/mods/1", headers: BEATMODS_HEADERS }).reply(200, JSON.stringify({
      mod: {
        versions: [
          {
            modVersion: "4.1.6",
            zipHash: "226190d94b21d1b0c7b1a42d855e419d",
            supportedGameVersions: [{ id: 2, version: "1.16.1" }],
          },
          {
            modVersion: "4.1.4",
            zipHash: "500a1dd3280db2d7df7292ec1fe7c4db",
            supportedGameVersions: [{ id: 1, version: "1.13.2" }],
          },
          {
            modVersion: "4.1.3",
            zipHash: "6cdb042c016ac1e9d2a3ffb29a1e8fb3",
            supportedGameVersions: [{ id: 1, version: "1.13.2" }],
          },
        ],
      },
    }));

    beatmods.intercept({ method: "GET", path: "/api/mods/2", headers: BEATMODS_HEADERS }).reply(200, JSON.stringify({
      mod: {
        versions: [
          {
            modVersion: "1.10.0",
            zipHash: "bc78cac4d7d680eeb96b751d3562bec4",
            supportedGameVersions: [{ id: 2, version: "1.16.1" }],
          },
          {
            modVersion: "1.7.0",
            zipHash: "43bb529b2a618e003faa949a7018fc63",
            supportedGameVersions: [{ id: 1, version: "1.13.2" }],
          },
          {
            modVersion: "1.6.0+1.16.2",
            zipHash: "3ca1bef2d413e1c63ef0c927e16b218b",
            supportedGameVersions: [{ id: 2, version: "1.16.1" }],
          },
          {
            modVersion: "1.6.0+1.13.2",
            zipHash: "a30692ebeedf94d180619f9c48f977dd",
            supportedGameVersions: [{ id: 1, version: "1.13.2" }],
          },
          {
            modVersion: "1.5.0+1.13.3",
            zipHash: "3dd7c2f56e14a30082209d908b6517cb",
            supportedGameVersions: [{ id: 4, version: "1.13.3" }],
          },
          {
            modVersion: "1.5.0+1.13.1",
            zipHash: "6b0ab2ac6993f9c26ee9b9aa957e3ef0",
            supportedGameVersions: [{ id: 3, version: "1.13.1" }],
          },
        ],
      },
    }));
  }

  async function mockDownloadRequests() {
    await mockDownloadRequest("6cdb042c016ac1e9d2a3ffb29a1e8fb3", "dummy.zip");
    await mockDownloadRequest("43bb529b2a618e003faa949a7018fc63", "dummy1.zip");
  }

  async function mockDownloadRequest(hash: string, file: string) {
    beatmods.intercept({ method: "GET", path: `/cdn/mod/${hash}.zip`, headers: BEATMODS_HEADERS }).reply(200, await readFile(path.join(__dirname, "files", file)));
  }

  async function mockGitHubRequest(version: string = "1.13.2") {
    github.intercept({ method: "GET", path: `/repos/nicoco007/BeatSaberReferenceAssemblies/zipball/refs/tags/v${version}`, headers: GITHUB_HEADERS }).reply(200, await readFile(
      path.join(__dirname, "files", "beat-saber-reference-assemblies.zip"),
    ));
  }

  it("extracts game assemblies and mods to the specified path", async () => {
    mockProject();
    await mockRequests();

    await run();

    agent.assertNoPendingInterceptors();

    assert.deepStrictEqual(infoMock.getCalls().map(v => v.args), [
      ["Downloading reference assemblies for version '1.13.2'"],
      ["Fetching mods"],
      ["Downloading BSIPA 4.1.3"],
      ["Downloading BS Utils 1.7.0"],
    ]);

    assert.deepStrictEqual(warningMock.getCalls().map(v => v.args), []);

    assertFileExists(path.join(OUTPUT_DIRECTORY, "IPA", "Data", "Data.txt"));
    assertFileExists(path.join(OUTPUT_DIRECTORY, "IPA", "Libs", "Libs.txt"));
    assertFileExists(path.join(OUTPUT_DIRECTORY, "Libs", "Libs.txt"));
    assertFileExists(path.join(OUTPUT_DIRECTORY, "Beat Saber_Data", "Managed", "Main.dll"));
    assertFileExists(path.join(OUTPUT_DIRECTORY, "Beat Saber_Data", "Data.txt"));
    assertFileExists(path.join(OUTPUT_DIRECTORY, "Plugins", "BS Utils.txt"));

    assert.equal(
      `BeatSaberDir=${OUTPUT_DIRECTORY}\n`
      + `GameDirectory=${OUTPUT_DIRECTORY}\n`,
      (await readFile(path.join(__dirname, GITHUB_ENV_FILE))).toString());
  });

  it("warns if game version doesn't exist on BeatMods and uses most recent version on BeatMods", async () => {
    mockProject({ gameVersion: "1.2.3" });
    mockVersionsRequest();
    mockModsRequest();
    await mockDownloadRequests();
    await mockModsRequests();
    await mockGitHubRequest("1.2.3");

    await run();

    agent.assertNoPendingInterceptors();

    assert.deepStrictEqual(warningMock.getCalls().map(v => v.args), [
      ["Game version '1.2.3' doesn't exist on BeatMods. Skipping game version support checks."],
    ]);
  });

  it("warns if mod doesn't exist", async () => {
    mockProject({ dependsOn: { "BSIPA": "^4.1.3", "BS Utils": "^1.6.3", "Foo": "^1.2.3" } });
    await mockRequests();

    await run();

    agent.assertNoPendingInterceptors();

    assert.deepStrictEqual(warningMock.getCalls().map(v => v.args), [
      ["Mod 'Foo' does not exist."],
    ]);
  });

  it("warns if mod version can't be found", async () => {
    mockProject({ dependsOn: { "BSIPA": "^3.0.0", "BS Utils": "^1.6.3" } });
    mockVersionsRequest();
    mockModsRequest();
    await mockModsRequests();
    await mockGitHubRequest();

    await mockDownloadRequest("43bb529b2a618e003faa949a7018fc63", "dummy1.zip");

    await run();

    agent.assertNoPendingInterceptors();

    assert.deepStrictEqual(warningMock.getCalls().map(v => v.args), [
      ["No version of BSIPA found that satisfies '^3.0.0'."],
    ]);
  });

  it("warns if mod doesn't support game version", async () => {
    mockProject({ gameVersion: "1.16.1" });

    mockVersionsRequest();
    mockModsRequest();
    await mockModsRequests();
    await mockDownloadRequests();
    await mockGitHubRequest("1.16.1");

    await run();

    agent.assertNoPendingInterceptors();

    assert.deepStrictEqual(warningMock.getCalls().map(v => v.args), [
      ["BSIPA 4.1.3 does not support Beat Saber 1.16.1."],
      ["BS Utils 1.7.0 does not support Beat Saber 1.16.1."],
    ]);
  });

  it("finds the most compatible version if multiple uploads share the same base version", async () => {
    mockProject({ dependsOn: { "BSIPA": "^4.1.3", "BS Utils": "1.6.0" } });

    mockVersionsRequest();
    mockModsRequest();
    mockModsRequests();
    await mockGitHubRequest();
    await mockDownloadRequest("6cdb042c016ac1e9d2a3ffb29a1e8fb3", "dummy.zip");
    await mockDownloadRequest("a30692ebeedf94d180619f9c48f977dd", "dummy1.zip");

    await run();

    agent.assertNoPendingInterceptors();
    assert.deepStrictEqual(warningMock.getCalls().map(v => v.args), []);
  });

  it("finds the most compatible version if multiple uploads share the same base version and no version supports the specified game version", async () => {
    mockProject({ dependsOn: { "BSIPA": "^4.1.3", "BS Utils": "1.5.0" } });

    mockVersionsRequest();
    mockModsRequest();
    await mockModsRequests();
    await mockGitHubRequest();
    await mockDownloadRequest("6cdb042c016ac1e9d2a3ffb29a1e8fb3", "dummy.zip");
    await mockDownloadRequest("6b0ab2ac6993f9c26ee9b9aa957e3ef0", "dummy1.zip");

    await run();

    agent.assertNoPendingInterceptors();
  });

  it("rejects if a BeatMods request fails", async () => {
    mockProject();

    beatmods.intercept({ method: "GET", path: "/api/versions?gameName=BeatSaber", headers: BEATMODS_HEADERS }).reply(500);

    await assert.rejects(async () => await run(), new Error("Request 'https://beatmods.com/api/versions?gameName=BeatSaber' failed: 500 Internal Server Error"));

    agent.assertNoPendingInterceptors();
  });

  it("rejects if a GitHub request fails", async () => {
    mockProject();

    beatmods.intercept({ method: "GET", path: "/api/versions?gameName=BeatSaber", headers: BEATMODS_HEADERS }).reply(200, JSON.stringify({
      versions: [
        { id: 1, version: "1.13.2", defaultVersion: true },
        { id: 2, version: "1.16.1", defaultVersion: false },
        { id: 3, version: "1.13.1", defaultVersion: false },
        { id: 4, version: "1.13.3", defaultVersion: false },
      ],
    }));

    github
      .intercept({ method: "GET", path: "/repos/nicoco007/BeatSaberReferenceAssemblies/zipball/refs/tags/v1.13.2", headers: GITHUB_HEADERS })
      .reply(500);

    await assert.rejects(async () => await run(), new Error("Request 'https://api.github.com/repos/nicoco007/BeatSaberReferenceAssemblies/zipball/refs/tags/v1.13.2' failed: 500 Internal Server Error"));

    agent.assertNoPendingInterceptors();
  });

  it("rejects if a download request fails", async () => {
    mockProject();

    mockVersionsRequest();
    mockModsRequest();
    await mockModsRequests();
    await mockGitHubRequest();

    await mockDownloadRequest("6cdb042c016ac1e9d2a3ffb29a1e8fb3", "dummy.zip");
    beatmods.intercept({ method: "GET", path: "/cdn/mod/43bb529b2a618e003faa949a7018fc63.zip", headers: BEATMODS_HEADERS }).reply(500);

    await assert.rejects(async () => await run(), new Error("Request 'https://beatmods.com/cdn/mod/43bb529b2a618e003faa949a7018fc63.zip' failed: 500 Internal Server Error"));

    agent.assertNoPendingInterceptors();
  });

  it("reject if dotnet output cannot be parsed", async () => {
    mockProcess(
      "dotnet",
      sinon.match.any,
      "garbled",
    );

    await assert.rejects(async () => await run(), new SyntaxError("Unexpected token 'g', \"garbled\" is not valid JSON"));

    agent.assertNoPendingInterceptors();
  });

  it("reject if dotnet does not return exit code 0", async () => {
    mockProcess(
      "dotnet",
      sinon.match.any,
      "output",
      "uh oh",
      -1,
    );
    await assert.rejects(async () => await run(), new Error("dotnet returned exit code -1. Output:\noutput\nError\nuh oh"));

    agent.assertNoPendingInterceptors();
  });

  afterEach(async () => {
    await rm(path.join(OUTPUT_DIRECTORY), {
      recursive: true,
      force: true,
    });

    await rm(path.join(__dirname, GITHUB_ENV_FILE), {
      force: true,
    });

    sinon.reset();

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
