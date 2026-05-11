jest.mock("@actions/core");
jest.mock("@actions/exec");
jest.mock("@actions/io");
jest.mock("@actions/tool-cache");
jest.mock("@actions/cache");

const os = require("os");

const core = require("@actions/core");
const exec = require("@actions/exec");
const io = require("@actions/io");
const tc = require("@actions/tool-cache");
const cache = require("@actions/cache");
const httpm = require("@actions/http-client");

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
    expect.arrayContaining([
      "install",
      `aws-sam-cli==${test.expected.version}`,
    ]),
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

test.each([
  ["x64", "x86_64", "1.104.567"],
  ["arm64", "arm64", "1.104.0"],
  ["x64", "x86_64", "1.23.456"],
  ["arm64", "arm64", "1.135.0"],
])(
  "when use-installer enabled and version specified and cached version exists, uses cached version %s",
  async (inputArch, expectedArch, input) => {
    jest.spyOn(os, "platform").mockReturnValue("linux");
    jest.spyOn(os, "arch").mockReturnValue(inputArch);

    // Mock ImageOS environment variable
    const originalImageOS = process.env.ImageOS;
    process.env.ImageOS = "ubuntu22";

    core.getBooleanInput = jest.fn().mockReturnValue(true);
    core.getInput = jest.fn().mockReturnValueOnce(input);

    cache.restoreCache = jest.fn().mockResolvedValueOnce("cache-key-hit");

    await setup();

    expect(cache.restoreCache).toHaveBeenCalledTimes(1);
    expect(cache.restoreCache).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining(".sam-cli-cache")]),
      `sam-cli-linux-ubuntu22-${expectedArch}-${input}`,
    );
    expect(cache.saveCache).toHaveBeenCalledTimes(0);
    expect(tc.downloadTool).toHaveBeenCalledTimes(0);

    expect(core.addPath).toHaveBeenCalled();

    // Restore original ImageOS
    if (originalImageOS === undefined) {
      delete process.env.ImageOS;
    } else {
      process.env.ImageOS = originalImageOS;
    }
  },
);

test.each([
  ["x64", "x86_64", "1.104.567"],
  ["arm64", "arm64", "1.104.0"],
  ["x64", "x86_64", "1.23.456"],
  ["arm64", "arm64", "1.135.0"],
])(
  "when use-installer enabled and version specified and cached version does not exist, downloads and caches version %s",
  async (inputArch, expectedArch, input) => {
    jest.spyOn(os, "platform").mockReturnValue("linux");
    jest.spyOn(os, "arch").mockReturnValue(inputArch);

    // Mock ImageOS environment variable
    const originalImageOS = process.env.ImageOS;
    process.env.ImageOS = "ubuntu22";

    core.getBooleanInput = jest.fn().mockReturnValue(true);
    core.getInput = jest.fn().mockReturnValueOnce(input);

    cache.restoreCache = jest.fn().mockResolvedValueOnce(undefined);
    cache.saveCache = jest.fn().mockResolvedValueOnce(1);
    tc.extractZip = jest.fn().mockResolvedValueOnce(undefined);
    tc.downloadTool = jest
      .fn()
      .mockResolvedValueOnce("/path/to/downloaded/sam");

    await setup();

    expect(cache.restoreCache).toHaveBeenCalledTimes(1);
    expect(tc.downloadTool).toHaveBeenCalledTimes(1);
    expect(tc.extractZip).toHaveBeenCalledTimes(1);
    expect(cache.saveCache).toHaveBeenCalledTimes(1);
    expect(cache.saveCache).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining(".sam-cli-cache")]),
      `sam-cli-linux-ubuntu22-${expectedArch}-${input}`,
    );

    expect(core.addPath).toHaveBeenCalled();

    // Restore original ImageOS
    if (originalImageOS === undefined) {
      delete process.env.ImageOS;
    } else {
      process.env.ImageOS = originalImageOS;
    }
  },
);

test("when use-installer enabled and version is too old for ARM, fails on ARM architecture", async () => {
  jest.spyOn(os, "platform").mockReturnValue("linux");
  jest.spyOn(os, "arch").mockReturnValue("arm64");

  core.getBooleanInput = jest.fn().mockReturnValue(true);
  core.getInput = jest.fn().mockReturnValueOnce("1.103.0");

  await setup();

  expect(core.setFailed).toHaveBeenCalledWith(
    "ARM64 installer is only available for versions 1.104.0 and above",
  );
  expect(tc.downloadTool).not.toHaveBeenCalled();
  expect(cache.restoreCache).not.toHaveBeenCalled();
});

test.each([
  ["x64", "x86_64"],
  ["arm64", "arm64"],
])(
  "when use-installer enabled and version not specified, cache latest version (Linux %s)",
  async (inputArch, expectedArch) => {
    jest.spyOn(os, "platform").mockReturnValue("linux");
    jest.spyOn(os, "arch").mockReturnValue(inputArch);

    // Mock ImageOS environment variable
    const originalImageOS = process.env.ImageOS;
    process.env.ImageOS = "ubuntu22";

    core.getBooleanInput = jest.fn().mockReturnValue(true);
    core.getInput = jest.fn().mockReturnValueOnce("");

    jest.spyOn(httpm.HttpClient.prototype, "get").mockResolvedValue({
      message: { statusCode: 200 },
      readBody: () => {
        return `{ "tag_name": "v1.139.0" }`;
      },
    });

    cache.restoreCache = jest.fn().mockResolvedValueOnce(undefined);
    cache.saveCache = jest.fn().mockResolvedValueOnce(1);
    tc.extractZip = jest.fn().mockResolvedValueOnce(undefined);
    tc.downloadTool = jest
      .fn()
      .mockResolvedValueOnce("/path/to/downloaded/sam");

    await setup();

    expect(tc.downloadTool).toHaveBeenCalledWith(
      `https://github.com/aws/aws-sam-cli/releases/download/v1.139.0/aws-sam-cli-linux-${expectedArch}.zip`,
    );

    expect(cache.restoreCache).toHaveBeenCalledTimes(1);
    expect(cache.saveCache).toHaveBeenCalledTimes(1);
    expect(core.addPath).toHaveBeenCalled();

    // Restore original ImageOS
    if (originalImageOS === undefined) {
      delete process.env.ImageOS;
    } else {
      process.env.ImageOS = originalImageOS;
    }
  },
);

test.each([
  {
    arch: "x64",
    releaseTagVersion: "v1.110.0",
    input: { userInstaller: true },
    expected: {
      arch: "x86_64",
      latestVersion: "v1.110.0",
      headers: undefined,
    },
  },
  {
    arch: "x64",
    releaseTagVersion: "v1.110.0",
    input: { userInstaller: true, token: "" },
    expected: {
      arch: "x86_64",
      latestVersion: "v1.110.0",
      headers: undefined,
    },
  },
  {
    arch: "x64",
    releaseTagVersion: "v1.110.0",
    input: { userInstaller: true, token: "1234abc" },
    expected: {
      arch: "x86_64",
      latestVersion: "v1.110.0",
      headers: {
        Authorization: "Bearer 1234abc",
      },
    },
  },
])("github api request %o", async (test) => {
  jest.spyOn(os, "platform").mockReturnValue("linux");
  jest.spyOn(os, "arch").mockReturnValue(test.arch);

  // Mock ImageOS environment variable
  const originalImageOS = process.env.ImageOS;
  process.env.ImageOS = "ubuntu22";

  const getMock = jest
    .spyOn(httpm.HttpClient.prototype, "get")
    .mockResolvedValue({
      message: { statusCode: 200 },
      readBody: () => {
        return `{ "tag_name": "${test.releaseTagVersion}" }`;
      },
    });

  core.getBooleanInput = jest.fn().mockReturnValue(test.input.userInstaller);
  core.getInput = jest
    .fn()
    .mockReturnValueOnce("")
    .mockReturnValueOnce("python3")
    .mockReturnValueOnce(test.input.token);

  cache.restoreCache = jest.fn().mockResolvedValueOnce(undefined);
  cache.saveCache = jest.fn().mockResolvedValueOnce(1);
  tc.extractZip = jest.fn().mockResolvedValueOnce(undefined);
  tc.downloadTool = jest.fn().mockResolvedValueOnce("/path/to/downloaded/sam");

  await setup();

  expect(getMock).toHaveBeenCalledWith(
    expect.anything(),
    test.expected.headers,
  );

  expect(tc.downloadTool).toHaveBeenCalledWith(
    `https://github.com/aws/aws-sam-cli/releases/download/${test.expected.latestVersion}/aws-sam-cli-linux-${test.expected.arch}.zip`,
  );

  expect(cache.restoreCache).toHaveBeenCalledTimes(1);
  expect(cache.saveCache).toHaveBeenCalledTimes(1);
  expect(core.addPath).toHaveBeenCalled();

  // Restore original ImageOS
  if (originalImageOS === undefined) {
    delete process.env.ImageOS;
  } else {
    process.env.ImageOS = originalImageOS;
  }
});

test.each([
  ["x64", "x86_64"],
  ["arm64", "arm64"],
])(
  "when use-installer enabled and version not specified, downloads latest version when getLatestReleaseTag failed (Linux %s)",
  async (archInput, expectedArch) => {
    jest.spyOn(os, "platform").mockReturnValue("linux");
    jest.spyOn(os, "arch").mockReturnValue(archInput);
    jest
      .spyOn(httpm.HttpClient.prototype, "get")
      .mockRejectedValueOnce(new Error("Mocked exception"));

    core.getBooleanInput = jest.fn().mockReturnValue(true);
    core.getInput = jest.fn().mockReturnValueOnce("");

    tc.extractZip = jest.fn().mockResolvedValueOnce(undefined);
    tc.downloadTool = jest
      .fn()
      .mockResolvedValueOnce("/path/to/downloaded/sam");

    await setup();

    expect(tc.downloadTool).toHaveBeenCalledWith(
      `https://github.com/aws/aws-sam-cli/releases/latest/download/aws-sam-cli-linux-${expectedArch}.zip`,
    );

    expect(cache.restoreCache).toHaveBeenCalledTimes(0);
    expect(cache.saveCache).toHaveBeenCalledTimes(0);
    expect(core.addPath).toHaveBeenCalled();
  },
);

test.each([["x64"], ["arm64"]])(
  "when use-installer enabled but version is not in format x.y.z, not downloaded or checked in cache (Linux %s)",
  async (archInput) => {
    jest.spyOn(os, "platform").mockReturnValue("linux");
    jest.spyOn(os, "arch").mockReturnValue(archInput);

    core.getBooleanInput = jest.fn().mockReturnValue(true);

    for (const version of ["1.2", "1.*", "3"]) {
      core.getInput = jest.fn().mockReturnValueOnce(version);
      await setup();
      expect(tc.downloadTool).toHaveBeenCalledTimes(0);
      expect(cache.restoreCache).toHaveBeenCalledTimes(0);
    }
  },
);

test.each([
  ["x64", "x86_64"],
  ["arm64", "arm64"],
])(
  "when use-installer enabled and version is nightly, downloads from sam-cli-nightly tag without caching (Linux %s)",
  async (inputArch, expectedArch) => {
    jest.spyOn(os, "platform").mockReturnValue("linux");
    jest.spyOn(os, "arch").mockReturnValue(inputArch);

    core.getBooleanInput = jest.fn().mockReturnValue(true);
    core.getInput = jest.fn().mockReturnValueOnce("nightly");

    tc.extractZip = jest.fn().mockResolvedValueOnce(undefined);
    tc.downloadTool = jest
      .fn()
      .mockResolvedValueOnce("/path/to/downloaded/sam");

    await setup();

    expect(tc.downloadTool).toHaveBeenCalledWith(
      `https://github.com/aws/aws-sam-cli/releases/download/sam-cli-nightly/aws-sam-cli-linux-${expectedArch}.zip`,
    );

    expect(cache.restoreCache).toHaveBeenCalledTimes(0);
    expect(cache.saveCache).toHaveBeenCalledTimes(0);
    expect(core.addPath).toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  },
);

test("when version is nightly but use-installer is false, fails with descriptive error", async () => {
  jest.spyOn(os, "platform").mockReturnValue("linux");

  core.getBooleanInput = jest.fn().mockReturnValue(false);
  core.getInput = jest.fn().mockReturnValueOnce("nightly");

  await setup();

  expect(core.setFailed).toHaveBeenCalledWith(
    expect.stringContaining('"use-installer: true"'),
  );
  expect(io.which).not.toHaveBeenCalled();
  expect(tc.downloadTool).not.toHaveBeenCalled();
  expect(core.addPath).not.toHaveBeenCalled();
});

describe("Windows native installer", () => {
  const fs = require("fs");
  const path = require("path");

  // path.join uses the host OS separator, so compute expected dirs the same way
  // the production code does to keep these tests cross-platform.
  const stableInstallRoot = path.join(
    "C:\\Program Files",
    "Amazon",
    "AWSSAMCLI",
  );
  const nightlyInstallRoot = path.join(
    "C:\\Program Files",
    "Amazon",
    "AWSSAMCLI_NIGHTLY",
  );
  const stableBinDir = path.join(stableInstallRoot, "bin");
  const nightlyBinDir = path.join(nightlyInstallRoot, "bin");

  let existsSyncSpy;
  let copyFileSyncSpy;
  let writeFileSyncSpy;
  let originalProgramFiles;

  beforeEach(() => {
    originalProgramFiles = process.env["ProgramFiles"];
    process.env["ProgramFiles"] = "C:\\Program Files";

    jest.spyOn(os, "platform").mockReturnValue("win32");

    existsSyncSpy = jest.spyOn(fs, "existsSync");
    copyFileSyncSpy = jest
      .spyOn(fs, "copyFileSync")
      .mockImplementation(() => {});
    writeFileSyncSpy = jest
      .spyOn(fs, "writeFileSync")
      .mockImplementation(() => {});

    tc.downloadTool = jest
      .fn()
      .mockResolvedValue("/tmp/AWS_SAM_CLI_64_PY3.msi");
    exec.exec = jest.fn().mockResolvedValue(0);
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
    copyFileSyncSpy.mockRestore();
    writeFileSyncSpy.mockRestore();
    if (originalProgramFiles === undefined) {
      delete process.env["ProgramFiles"];
    } else {
      process.env["ProgramFiles"] = originalProgramFiles;
    }
  });

  test("downloads MSI for a pinned version and runs msiexec", async () => {
    core.getBooleanInput = jest.fn().mockReturnValue(true);
    core.getInput = jest.fn().mockReturnValueOnce("1.139.0");

    existsSyncSpy.mockImplementation((p) => p === stableBinDir);

    await setup();

    expect(tc.downloadTool).toHaveBeenCalledWith(
      "https://github.com/aws/aws-sam-cli/releases/download/v1.139.0/AWS_SAM_CLI_64_PY3.msi",
      expect.stringMatching(/AWS_SAM_CLI_64_PY3\.msi$/),
    );
    expect(exec.exec).toHaveBeenCalledWith(
      "msiexec",
      expect.arrayContaining([
        "/i",
        expect.stringMatching(/AWS_SAM_CLI_64_PY3\.msi$/),
        "/qn",
        "/norestart",
      ]),
      expect.objectContaining({ ignoreReturnCode: true }),
    );
    expect(core.addPath).toHaveBeenCalledWith(stableBinDir);
    expect(copyFileSyncSpy).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  test("downloads MSI from latest URL when no version is provided", async () => {
    core.getBooleanInput = jest.fn().mockReturnValue(true);
    core.getInput = jest.fn().mockReturnValueOnce("");

    existsSyncSpy.mockImplementation((p) => p === stableBinDir);

    await setup();

    expect(tc.downloadTool).toHaveBeenCalledWith(
      "https://github.com/aws/aws-sam-cli/releases/latest/download/AWS_SAM_CLI_64_PY3.msi",
      expect.stringMatching(/AWS_SAM_CLI_64_PY3\.msi$/),
    );
    expect(core.addPath).toHaveBeenCalledWith(stableBinDir);
  });

  test("nightly: downloads from sam-cli-nightly tag and aliases sam-nightly to sam", async () => {
    core.getBooleanInput = jest.fn().mockReturnValue(true);
    core.getInput = jest.fn().mockReturnValueOnce("nightly");

    // Pretend the nightly install dir and sam-nightly.* exist; sam.* does not yet.
    const samNightlyCmd = path.join(nightlyBinDir, "sam-nightly.cmd");
    const samNightlyExe = path.join(nightlyBinDir, "sam-nightly.exe");
    existsSyncSpy.mockImplementation(
      (p) => p === nightlyBinDir || p === samNightlyCmd || p === samNightlyExe,
    );

    await setup();

    expect(tc.downloadTool).toHaveBeenCalledWith(
      "https://github.com/aws/aws-sam-cli/releases/download/sam-cli-nightly/AWS_SAM_CLI_64_PY3.msi",
      expect.stringMatching(/AWS_SAM_CLI_64_PY3\.msi$/),
    );
    expect(core.addPath).toHaveBeenCalledWith(nightlyBinDir);
    // Both sam.cmd and sam.exe should have been copied from the nightly variants
    expect(copyFileSyncSpy).toHaveBeenCalledWith(
      samNightlyCmd,
      path.join(nightlyBinDir, "sam.cmd"),
    );
    expect(copyFileSyncSpy).toHaveBeenCalledWith(
      samNightlyExe,
      path.join(nightlyBinDir, "sam.exe"),
    );
  });

  test("treats msiexec exit code 3010 (reboot required) as success", async () => {
    core.getBooleanInput = jest.fn().mockReturnValue(true);
    core.getInput = jest.fn().mockReturnValueOnce("1.139.0");

    exec.exec = jest.fn().mockResolvedValue(3010);
    existsSyncSpy.mockImplementation((p) => p === stableBinDir);

    await setup();

    expect(core.addPath).toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  test("fails when msiexec returns a non-zero, non-3010 exit code", async () => {
    core.getBooleanInput = jest.fn().mockReturnValue(true);
    core.getInput = jest.fn().mockReturnValueOnce("1.139.0");

    exec.exec = jest.fn().mockResolvedValue(1603);
    existsSyncSpy.mockReturnValue(false);

    await setup();

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("msiexec failed with exit code 1603"),
    );
    expect(core.addPath).not.toHaveBeenCalled();
  });

  test("fails when expected install directory is missing after MSI completes", async () => {
    core.getBooleanInput = jest.fn().mockReturnValue(true);
    core.getInput = jest.fn().mockReturnValueOnce("1.139.0");

    existsSyncSpy.mockReturnValue(false);

    await setup();

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("Expected SAM CLI install directory not found"),
    );
    expect(core.addPath).not.toHaveBeenCalled();
  });

  test("rejects invalid version string", async () => {
    core.getBooleanInput = jest.fn().mockReturnValue(true);
    core.getInput = jest.fn().mockReturnValueOnce("1.2");

    await setup();

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining(
        'Version must be in the format x.y.z or "nightly"',
      ),
    );
    expect(tc.downloadTool).not.toHaveBeenCalled();
  });

  test("uninstalls preinstalled stable SAM CLI before installing pinned version", async () => {
    core.getBooleanInput = jest.fn().mockReturnValue(true);
    core.getInput = jest.fn().mockReturnValueOnce("1.139.0");

    // Pretend a stable SAM CLI is already installed (install root exists),
    // and the bin dir exists after the new install completes.
    existsSyncSpy.mockImplementation(
      (p) => p === stableInstallRoot || p === stableBinDir,
    );

    await setup();

    // PowerShell uninstall is invoked with the stable install root passed
    // as the script argument, then msiexec /i runs for the new MSI.
    const calls = exec.exec.mock.calls;
    const uninstallCall = calls.find((c) => c[0] === "powershell");
    expect(uninstallCall).toBeDefined();
    expect(uninstallCall[1]).toEqual(expect.arrayContaining(["-File"]));
    expect(uninstallCall[1][uninstallCall[1].length - 1]).toBe(
      stableInstallRoot,
    );

    const installCall = calls.find((c) => c[0] === "msiexec");
    expect(installCall).toBeDefined();
    expect(calls.indexOf(uninstallCall)).toBeLessThan(
      calls.indexOf(installCall),
    );
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  test("skips uninstall when no existing install is present", async () => {
    core.getBooleanInput = jest.fn().mockReturnValue(true);
    core.getInput = jest.fn().mockReturnValueOnce("1.139.0");

    // Install root does not exist before install; bin dir appears after.
    existsSyncSpy.mockImplementation((p) => p === stableBinDir);

    await setup();

    expect(
      exec.exec.mock.calls.find((c) => c[0] === "powershell"),
    ).toBeUndefined();
    expect(exec.exec.mock.calls.find((c) => c[0] === "msiexec")).toBeDefined();
  });

  test("uninstall targets nightly install root for nightly install", async () => {
    core.getBooleanInput = jest.fn().mockReturnValue(true);
    core.getInput = jest.fn().mockReturnValueOnce("nightly");

    const samNightlyCmd = path.join(nightlyBinDir, "sam-nightly.cmd");
    existsSyncSpy.mockImplementation(
      (p) =>
        p === nightlyInstallRoot || p === nightlyBinDir || p === samNightlyCmd,
    );

    await setup();

    const uninstallCall = exec.exec.mock.calls.find(
      (c) => c[0] === "powershell",
    );
    expect(uninstallCall).toBeDefined();
    expect(uninstallCall[1][uninstallCall[1].length - 1]).toBe(
      nightlyInstallRoot,
    );
  });
});

test("use-installer rejected on macOS", async () => {
  jest.spyOn(os, "platform").mockReturnValue("darwin");
  core.getBooleanInput = jest.fn().mockReturnValue(true);
  core.getInput = jest.fn().mockReturnValueOnce("1.139.0");

  await setup();

  expect(core.setFailed).toHaveBeenCalledWith(
    expect.stringContaining("only supported on Linux and Windows"),
  );
  expect(tc.downloadTool).not.toHaveBeenCalled();
});
