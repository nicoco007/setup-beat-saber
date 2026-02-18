import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import * as process from "process";
import * as path from "path";
import * as nf from "node-fetch";
import * as ac from "@actions/core";
import * as child_process from "child_process";
import fs from "fs-extra";
import { EventEmitter } from "events";
import { Readable } from "stream";
import { when } from "jest-when";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fetch = jest.fn().mockImplementation((url, params) => {
  throw new Error(
    `Unexpected web request to ${url} with ${JSON.stringify(params)}`,
  );
});
const childProcessSpawn = jest.fn();
const appendFileSync = jest.fn();
const readFileSync = jest.fn();
const writeFileSync = jest.fn();

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

jest.unstable_mockModule("child_process", () => ({
  ...child_process,
  __esModule: true,
  spawn: childProcessSpawn,
}));

jest.mock("fs-extra", () => ({
  ...fs,
  appendFileSync: appendFileSync,
  readFileSync: readFileSync,
  writeFileSync: writeFileSync,
}));

const { run } = await import("../src/main.js");
const core = await import("@actions/core");

function setInput(name: string, value: string) {
  process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] = value;
}

function deleteInput(name: string) {
  delete process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
}

function mockFetch(url: string, body: nf.BodyInit | undefined, status = 200) {
  when(fetch)
    .calledWith(url, { headers: { "User-Agent": "setup-beat-saber" } })
    .mockReturnValue(
      new nf.Response(body, {
        status: status,
        headers: new nf.Headers({
          "Content-Type": "application/json",
        }),
      }),
    );
}

function mockGitHubApiResponse(
  response: nf.Response | undefined = undefined,
  accessToken: string = "github_pat_whatever",
) {
  response ||= new nf.Response(
    fs.createReadStream(
      path.join(__dirname, "files", "beat-saber-reference-assemblies.zip"),
    ),
    {
      status: 200,
      headers: new nf.Headers({ "Content-Type": "application/octet-stream" }),
    },
  );

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "setup-beat-saber",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  when(fetch)
    .calledWith(
      expect.stringMatching(
        new RegExp(
          "https://api.github.com/repos/nicoco007/BeatSaberReferenceAssemblies/zipball/refs/tags/v.*",
        ),
      ),
      {
        method: "GET",
        headers: headers,
      },
    )
    .mockImplementation(() => response);
}

function mockDownloadResponse(response: nf.Response | undefined = undefined) {
  when(fetch)
    .calledWith(
      expect.stringMatching(new RegExp("https://beatmods.com/cdn/mod/.*")),
      { headers: { "User-Agent": "setup-beat-saber" } },
    )
    .mockImplementation(
      () =>
        response ||
        new nf.Response(
          fs.createReadStream(path.join(__dirname, "files", "dummy.zip")),
          {
            status: 200,
            headers: new nf.Headers({
              "Content-Type": "application/octet-stream",
            }),
          },
        ),
    );
}

function mockProcess(
  path: string,
  args: string[] = expect.anything(),
  stdout: string | undefined = undefined,
  stderr: string | undefined = undefined,
  exitCode: number = 0,
) {
  const proc = <child_process.ChildProcessWithoutNullStreams>new EventEmitter();
  proc.stdout = <Readable>new EventEmitter();
  proc.stderr = <Readable>new EventEmitter();

  when(childProcessSpawn)
    .calledWith(path, args)
    .mockImplementation(() => {
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
    BSIPA: "^4.1.3",
    "BS Utils": "^1.6.3",
    SongCore: "^3.0.2",
  },
}: { gameVersion?: string; dependsOn?: { [key: string]: string } } = {}) {
  mockProcess(
    "dotnet",
    expect.anything(),
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

describe("main", () => {
  const env = { ...process.env };

  beforeEach(() => {
    setInput("path", path.join(__dirname, "BeatSaberReferenceAssemblies"));
    setInput("access-token", "github_pat_whatever");
    setInput("project-path", path.join(__dirname, "Project", "Project.csproj"));
    setInput("project-configuration", "Release");
    setInput("aliases", "{}");
    setInput("additional-dependencies", "{}");

    process.env["GITHUB_ENV"] = "github_env.txt";
    process.env["GITHUB_SHA"] = "4ef156d43d79b5b63b421f7e867ff67d57ee42d8";

    mockGitHubApiResponse();
    mockDownloadResponse();
    mockProject();

    mockFetch(
      "https://beatmods.com/api/versions?gameName=BeatSaber",
      JSON.stringify({
        versions: [
          { id: 1, version: "1.13.2", defaultVersion: false },
          { id: 2, version: "1.16.1", defaultVersion: true },
        ],
      }),
    );
    mockFetch(
      "https://beatmods.com/api/mods?gameName=BeatSaber&status=all&gameVersion=1.13.2",
      JSON.stringify({
        mods: [
          {
            mod: { id: 1, name: "BSIPA" },
            latest: {
              modVersion: "4.1.4",
              zipHash: "600a59038384cf2e7ec72582",
              supportedGameVersions: [{ id: 1 }],
            },
          },
          {
            mod: { id: 2, name: "BS Utils" },
            latest: {
              modVersion: "1.7.0",
              zipHash: "600a65978384cf2e7ec725a9",
              supportedGameVersions: [{ id: 1 }],
            },
          },
          {
            mod: { id: 3, name: "SongCore" },
            latest: {
              modVersion: "3.1.0",
              zipHash: "6015b97e0eef816aa6d0c18a",
              supportedGameVersions: [{ id: 1 }],
            },
          },
        ],
      }),
    );
    mockFetch(
      "https://beatmods.com/api/mods?gameName=BeatSaber&status=all&gameVersion=1.16.1",
      JSON.stringify({
        mods: [
          {
            mod: { id: 4, name: "BSIPA" },
            latest: {
              modVersion: "4.1.6",
              zipHash: "60b14ea32d008b3daa41e8e0",
              supportedGameVersions: [{ id: 2 }],
            },
          },
          {
            mod: { id: 5, name: "BS Utils" },
            latest: {
              modVersion: "1.10.0",
              zipHash: "60b15a4b2d008b3daa41e900",
              supportedGameVersions: [{ id: 2 }],
            },
          },
          {
            mod: { id: 6, name: "SongCore" },
            latest: {
              modVersion: "3.5.0",
              zipHash: "60cbfebfaf1e3d4577e0366e",
              supportedGameVersions: [{ id: 2 }],
            },
          },
        ],
      }),
    );
    mockFetch(
      "https://beatmods.com/api/mods?gameName=BeatSaber&status=all",
      JSON.stringify({
        mods: [
          {
            mod: { id: 1, name: "BSIPA" },
            latest: {
              modVersion: "4.1.4",
              zipHash: "600a59038384cf2e7ec72582",
              supportedGameVersions: [{ id: 1 }],
            },
          },
          {
            mod: { id: 1, name: "BSIPA" },
            latest: {
              modVersion: "4.1.3",
              zipHash: "600a59038384cf2e7ec72582",
              supportedGameVersions: [{ id: 1 }],
            },
          },
          {
            mod: { id: 1, name: "BSIPA" },
            latest: {
              modVersion: "4.1.6",
              zipHash: "60b14ea32d008b3daa41e8e0",
              supportedGameVersions: [{ id: 2 }],
            },
          },
          {
            mod: { id: 2, name: "BS Utils" },
            latest: {
              modVersion: "1.7.0",
              zipHash: "600a65978384cf2e7ec725a9",
              supportedGameVersions: [{ id: 1 }],
            },
          },
          {
            mod: { id: 2, name: "BS Utils" },
            latest: {
              modVersion: "1.10.0",
              zipHash: "60b15a4b2d008b3daa41e900",
              supportedGameVersions: [{ id: 2 }],
            },
          },
          {
            mod: { id: 3, name: "SongCore" },
            latest: {
              modVersion: "3.1.0",
              zipHash: "6015b97e0eef816aa6d0c18a",
              supportedGameVersions: [{ id: 1 }],
            },
          },
          {
            mod: { id: 3, name: "SongCore" },
            latest: {
              modVersion: "3.5.0",
              zipHash: "60cbfebfaf1e3d4577e0366e",
              supportedGameVersions: [{ id: 2 }],
            },
          },
        ],
      }),
    );
    mockFetch(
      "https://beatmods.com/api/mods/1",
      JSON.stringify({
        mod: {
          versions: [
            {
              modVersion: "4.1.4",
              zipHash: "600a59038384cf2e7ec72582",
              supportedGameVersions: [{ id: 1 }],
            },
            {
              modVersion: "4.1.3",
              zipHash: "600a59038384cf2e7ec72582",
              supportedGameVersions: [{ id: 1 }],
            },
            {
              modVersion: "4.1.6",
              zipHash: "60b14ea32d008b3daa41e8e0",
              supportedGameVersions: [{ id: 2 }],
            },
          ],
        },
      }),
    );
  });

  it("downloads reference assemblies", async () => {
    await run();

    expect(
      fs.existsSync(
        path.join(
          __dirname,
          "BeatSaberReferenceAssemblies",
          "Beat Saber_Data",
          "Managed",
          "Main.dll",
        ),
      ),
    ).toBe(true);
  });

  it("throws if reference assemblies response isn't successful", async () => {
    mockGitHubApiResponse(
      new nf.Response(null, { status: 401, statusText: "Unauthorized" }),
    );

    await expect(run()).rejects.toThrow(
      "Unexpected response status 401 Unauthorized",
    );
  });

  it("downloads all mods listed in manifest", async () => {
    await run();

    expect(fetch).toHaveBeenCalledWith(
      "https://beatmods.com/api/mods?gameName=BeatSaber&status=all&gameVersion=1.13.2",
      { headers: { "User-Agent": "setup-beat-saber" } },
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://beatmods.com/cdn/mod/600a59038384cf2e7ec72582.zip",
      { headers: { "User-Agent": "setup-beat-saber" } },
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://beatmods.com/cdn/mod/600a65978384cf2e7ec725a9.zip",
      { headers: { "User-Agent": "setup-beat-saber" } },
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://beatmods.com/cdn/mod/6015b97e0eef816aa6d0c18a.zip",
      { headers: { "User-Agent": "setup-beat-saber" } },
    );
  });

  it("uses the action's game-version if specified", async () => {
    setInput("game-version", "1.16.1");

    await run();

    expect(fetch).toHaveBeenCalledWith(
      "https://beatmods.com/api/mods?gameName=BeatSaber&status=all&gameVersion=1.16.1",
      { headers: { "User-Agent": "setup-beat-saber" } },
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://beatmods.com/cdn/mod/60b14ea32d008b3daa41e8e0.zip",
      { headers: { "User-Agent": "setup-beat-saber" } },
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://beatmods.com/cdn/mod/60b15a4b2d008b3daa41e900.zip",
      { headers: { "User-Agent": "setup-beat-saber" } },
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://beatmods.com/cdn/mod/60cbfebfaf1e3d4577e0366e.zip",
      { headers: { "User-Agent": "setup-beat-saber" } },
    );
  });

  it("uses matching mod version if latest does not match version range", async () => {
    mockProject({ dependsOn: { BSIPA: "4.1.3" } });

    await run();

    expect(core.info).toHaveBeenCalledWith(
      "Using mod 'BSIPA' version '4.1.3' for game version '1.13.2'.",
    );
  });

  it("warns when matching mod version if latest does not match version range and found version is not on game version", async () => {
    mockProject({ dependsOn: { BSIPA: "4.1.6" } });

    await run();

    expect(core.warning).toHaveBeenCalledWith(
      "No version of mod 'BSIPA' found for game version '1.13.2'. Using mod version match '4.1.6'.",
    );
  });

  it("fails if no mod version matches the specified range", async () => {
    mockProject({ dependsOn: { BSIPA: "4.1.5" } });

    await run();

    expect(core.warning).toHaveBeenCalledWith(
      "No version of mod 'BSIPA' found that satisfies '4.1.5'.",
    );
  });

  it("defaults to the default version on BeatMods if the specified version doesn't exist", async () => {
    mockProject({ gameVersion: "1.15.3" });

    await run();

    expect(core.warning).toHaveBeenCalledWith(
      "Game version '1.15.3' doesn't exist; using mods from latest version '1.16.1'",
    );
  });

  it("defaults to the latest version on BeatMods if the specified version doesn't exist and no default version exists", async () => {
    mockProject({ gameVersion: "1.15.3" });

    mockFetch(
      "https://beatmods.com/api/versions?gameName=BeatSaber",
      JSON.stringify({
        versions: [
          { id: 1, version: "1.13.2", defaultVersion: false },
          { id: 2, version: "1.16.1", defaultVersion: false },
        ],
      }),
    );

    await run();

    expect(core.warning).toHaveBeenCalledWith(
      "Game version '1.15.3' doesn't exist; using mods from latest version '1.13.2'",
    );
  });

  it("logs when a mod version doesn't exist", async () => {
    mockProject({ dependsOn: { Dummy: "^4.1.0" } });

    await run();

    expect(core.warning).toHaveBeenCalledWith("Mod 'Dummy' does not exist.");
  });

  it("rejects if mod download response isn't successful", async () => {
    mockDownloadResponse(
      new nf.Response(null, { status: 401, statusText: "Unauthorized" }),
    );

    await expect(run()).rejects.toThrow(
      "Unexpected response status 401 Unauthorized",
    );
  });

  it("rejects if project info can't be parsed", async () => {
    mockProcess("dotnet", expect.anything(), "blah");

    await expect(run()).rejects.toThrow(
      "Unexpected token 'b', \"blah\" is not valid JSON",
    );
  });

  it("rejects if project info can't be retrieved", async () => {
    mockProcess("dotnet", expect.anything(), undefined, "Uh oh!", 1);

    await expect(run()).rejects.toThrow("Uh oh!");
  });

  it("doesn't explode if access token isn't specified", async () => {
    deleteInput("access-token");
    mockGitHubApiResponse(undefined, "");

    await run();

    expect(core.info).toHaveBeenCalledWith(
      "Using mod 'BSIPA' version '4.1.4' for game version '1.13.2'.",
    );
  });

  afterEach(() => {
    fs.rmSync(path.join(__dirname, "BeatSaberReferenceAssemblies"), {
      recursive: true,
      force: true,
    });

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
