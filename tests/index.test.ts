"use strict";

import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";

describe("index", () => {
  const runMock = mock.fn<() => Promise<void>>();
  const setFailedMock = mock.fn<(message: string | Error) => void>();

  before(async () => {
    mock.module("@actions/core", {
      namedExports: { setFailed: setFailedMock },
    });

    mock.module("../src/main.ts", {
      namedExports: { run: runMock },
    });
  });

  it("calls setFailed if the promise rejects", async () => {
    const error = new Error("oh no");

    runMock.mock.mockImplementationOnce(() => {
      return Promise.reject(error);
    });

    await import("../src/index.js");

    assert.strictEqual(runMock.mock.callCount(), 1);
    assert.strictEqual(setFailedMock.mock.callCount(), 1);
    assert.deepStrictEqual(setFailedMock.mock.calls[0].arguments, ["Error: oh no"]);
  });
});
