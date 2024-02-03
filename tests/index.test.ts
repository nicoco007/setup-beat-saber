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
    runMock.mockReturnValue(Promise.reject(new Error("oh no")));

    await import("../src/index.js");

    expect(runMock).toHaveBeenCalled();
    expect(setFailedMock).toHaveBeenCalledWith("oh no");
  });
});
