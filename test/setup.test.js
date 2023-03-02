jest.mock("@actions/core");
jest.mock("@actions/exec");
jest.mock("@actions/io");
jest.mock("@actions/tool-cache");

const os = require("os");

const core = require("@actions/core");
const exec = require("@actions/exec");
const io = require("@actions/io");
const tc = require("@actions/tool-cache");

const setup = require("../lib/setup");

afterEach(() => {
  jest.clearAllMocks();
});

test.each([
  {
    platform: "linux",
    input: {},
    expected: { version: "1.*", python: "python3" },
  },
  {
    platform: "linux",
    input: { version: "" },
    expected: { version: "1.*", python: "python3" },
  },
  {
    platform: "darwin",
    input: {},
    expected: { version: "1.*", python: "python3" },
  },
  {
    platform: "win32",
    input: {},
    expected: { version: "1.*", python: "python" },
  },
  {
    platform: "linux",
    input: { version: "1.2.*" },
    expected: { version: "1.2.*", python: "python3" },
  },
  {
    platform: "linux",
    input: { python: "/root/Python 1.2.3" },
    expected: { version: "1.*", python: "/root/Python 1.2.3" },
  },
  {
    platform: "linux",
    input: { version: "1.2.3", python: "python1.2.3" },
    expected: { version: "1.2.3", python: "python1.2.3" },
  },
])("setup %o", async (test) => {
  jest.spyOn(os, "platform").mockReturnValue(test.platform);

  core.getInput = jest
    .fn()
    .mockReturnValueOnce(test.input.version)
    .mockReturnValueOnce(test.input.python);

  await setup();

  expect(io.which).toHaveBeenCalledWith(test.expected.python, true);
  expect(exec.exec).toHaveBeenCalledWith(
    expect.anything(),
    expect.arrayContaining(["install", `aws-sam-cli==${test.expected.version}`])
  );
  expect(core.addPath).toHaveBeenCalledTimes(1);
});

test.each([
  {
    version: "not valid",
  },
  {
    version: "not|valid",
  },
])("invalid input %o", async (input) => {
  core.getInput = jest
    .fn()
    .mockReturnValueOnce(input.version)
    .mockReturnValueOnce(input.python);
  await expect(setup).rejects.toThrow(Error);
});

test("when use-installer enabled and version specified and cached version exists, uses cached version", async () => {
  jest.spyOn(os, "platform").mockReturnValue("linux");
  jest.spyOn(os, "arch").mockReturnValue("x64");

  core.getBooleanInput = jest.fn().mockReturnValue(true);
  core.getInput = jest.fn().mockReturnValueOnce("1.23.456");

  tc.find = jest.fn().mockReturnValueOnce("/path/to/cached/sam");

  await setup();

  expect(tc.find).toHaveBeenCalledTimes(1);
  expect(tc.cacheDir).toHaveBeenCalledTimes(0);

  // Must be cached path
  expect(core.addPath).toHaveBeenCalledWith("/path/to/cached/sam/dist");
});

test("when use-installer enabled and version specified and cached version does not exist, downloads and caches version", async () => {
  jest.spyOn(os, "platform").mockReturnValue("linux");
  jest.spyOn(os, "arch").mockReturnValue("x64");

  core.getBooleanInput = jest.fn().mockReturnValue(true);
  core.getInput = jest.fn().mockReturnValueOnce("1.23.456");

  tc.find = jest.fn().mockReturnValueOnce("");
  tc.extractZip = jest.fn().mockReturnValueOnce("/path/to/extracted/sam");
  tc.cacheDir = jest.fn().mockReturnValueOnce("/path/to/cached/sam");

  await setup();

  expect(tc.find).toHaveBeenCalledTimes(1);
  expect(tc.cacheDir).toHaveBeenCalledTimes(1);

  // Must return cached path
  expect(core.addPath).toHaveBeenCalledWith("/path/to/cached/sam/dist");
});

test("when use-installer enabled and version not specified, downloads latest version (Linux x64)", async () => {
  jest.spyOn(os, "platform").mockReturnValue("linux");
  jest.spyOn(os, "arch").mockReturnValue("x64");

  core.getBooleanInput = jest.fn().mockReturnValue(true);
  core.getInput = jest.fn().mockReturnValueOnce("");

  tc.find = jest.fn().mockReturnValueOnce("");
  tc.extractZip = jest.fn().mockReturnValueOnce("/path/to/extracted/sam");
  tc.cacheDir = jest.fn().mockReturnValueOnce("/path/to/cached/sam");
  tc.downloadTool = jest.fn().mockReturnValueOnce("/path/to/downloaded/sam");

  await setup();

  expect(tc.downloadTool).toHaveBeenCalledWith(
    "https://github.com/aws/aws-sam-cli/releases/latest/download/aws-sam-cli-linux-x86_64.zip"
  );

  // Currently no caching on latest
  expect(tc.find).toHaveBeenCalledTimes(0);
  expect(tc.cacheDir).toHaveBeenCalledTimes(0);
  expect(core.addPath).toHaveBeenCalledWith("/path/to/extracted/sam/dist");
});

test("when use-installer enabled but version is not in format x.y.z, not downloaded or checked in cache", async () => {
  jest.spyOn(os, "platform").mockReturnValue("linux");
  jest.spyOn(os, "arch").mockReturnValue("x64");

  core.getBooleanInput = jest.fn().mockReturnValue(true);

  for (const version of ["1.2", "1.*", "3"]) {
    core.getInput = jest.fn().mockReturnValueOnce(version);
    await setup();
    expect(tc.downloadTool).toHaveBeenCalledTimes(0);
    expect(tc.find).toHaveBeenCalledTimes(0);
  }
});
