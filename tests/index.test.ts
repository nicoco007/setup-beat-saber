import { jest } from "@jest/globals";

const runMock = jest.fn();

jest.unstable_mockModule("../src/main", () => ({
    __esModule: true,
    run: runMock,
}));

describe('index', () => {
    it('calls run when imported', async () => {
      runMock.mockReturnValue(Promise.resolve());
  
      await import('../src/index');
  
      expect(runMock).toHaveBeenCalled();
    });
});
