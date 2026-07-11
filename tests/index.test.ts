import { jest } from "@jest/globals";

const runMock = jest.fn();
const setFailedMock = jest.fn();

jest.unstable_mockModule("../src/main", () => ({
  __esModule: true,
  run: runMock,
}));

jest.unstable_mockModule("@actions/core", () => ({
  __esModule: true,
  setFailed: setFailedMock,
}));

describe("index", () => {
  it("calls run when imported", async () => {
    const error = new Error("oh no");

    runMock.mockReturnValue(Promise.reject(error));

    await import("../src/index.js");

    expect(runMock).toHaveBeenCalled();
    expect(setFailedMock).toHaveBeenCalledWith("Error: oh no");
  });
});
