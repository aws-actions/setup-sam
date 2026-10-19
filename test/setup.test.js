jest.mock("@actions/core");
jest.mock("@actions/exec");
jest.mock("@actions/io");
jest.mock("@actions/tool-cache");
jest.mock("@actions/cache");

const os = require("os");
const path = require("path");

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

// ---------------------------------------------------------------------------
// Native installer / cache integrity
//
// The action caches the release archive (not the extracted directory) and
// verifies it against the SHA256 digest published on the GitHub release before
// trusting it. Restored cache content is writable by anything that can write
// to a cache scope the job reads, so these tests pin the verification
// behaviour.
// ---------------------------------------------------------------------------

const fs = require("fs");
const crypto = require("crypto");

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

const GOOD_ARCHIVE = Buffer.from("official aws-sam-cli release archive");
const GOOD_SHA256 = sha256(GOOD_ARCHIVE);
const OTHER_ARCHIVE = Buffer.from("some other archive contents");

/** A digest belonging to a different asset of the same release. */
const DECOY_SHA256 = sha256(Buffer.from("a different architecture's archive"));

/**
 * Builds a GitHub release payload.
 *
 * Real releases carry an archive per architecture plus installers for other
 * platforms, so the fixture lists several assets and gives the one named by
 * `arch` the digest under test. Every other asset carries a decoy digest, so a
 * lookup that picks the wrong asset - by suffix, by position, or by ignoring
 * the architecture - fails verification instead of passing by coincidence.
 *
 * GitHub only populates `digest` for releases published after mid-2025, so
 * `digest: null` models an older release.
 *
 * @param {string} tag - The release tag, e.g. "v1.166.2".
 * @param {string} arch - The architecture whose asset carries `digest`.
 * @param {string|null} digest - Hex SHA256, or null to model an older release.
 */
function releaseBody(tag, arch, digest) {
  const other = arch === "arm64" ? "x86_64" : "arm64";
  const decoy = digest ? `sha256:${DECOY_SHA256}` : null;

  return JSON.stringify({
    tag_name: tag,
    assets: [
      // Deliberately listed before the asset under test so that picking the
      // first entry, rather than matching on name, is caught.
      { name: `aws-sam-cli-linux-${other}.zip`, digest: decoy },
      { name: `aws-sam-cli-linux-${other}.zip.sig`, digest: decoy },
      {
        name: `aws-sam-cli-linux-${arch}.zip`,
        digest: digest ? `sha256:${digest}` : null,
      },
      { name: `aws-sam-cli-linux-${arch}.zip.sig`, digest: decoy },
      { name: "aws-sam-cli-macos-arm64.pkg", digest: decoy },
      { name: "AWS_SAM_CLI_64_PY3.msi", digest: decoy },
    ],
  });
}

function mockRelease(tag, arch, digest) {
  return jest.spyOn(httpm.HttpClient.prototype, "get").mockResolvedValue({
    message: { statusCode: 200 },
    readBody: () => releaseBody(tag, arch, digest),
  });
}

let fakeHome;

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "setup-sam-home-"));
  jest.spyOn(os, "homedir").mockReturnValue(fakeHome);
});

afterEach(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

function archivePathFor(version, arch) {
  return path.join(
    fakeHome,
    ".sam-cli-cache",
    version,
    `aws-sam-cli-linux-${arch}.zip`,
  );
}

/** Simulates restoreCache writing the entry back to disk. */
function seedCache(version, arch, contents) {
  const target = archivePathFor(version, arch);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

/** Simulates downloadTool by returning a real file on disk. */
function stubDownload(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-sam-dl-"));
  const file = path.join(dir, "download.zip");
  fs.writeFileSync(file, contents);
  tc.downloadTool = jest.fn().mockResolvedValue(file);
  return file;
}

function useInstaller(version) {
  core.getBooleanInput = jest.fn().mockReturnValue(true);
  core.getInput = jest.fn().mockReturnValueOnce(version);
}

test.each([
  ["x64", "x86_64", "1.166.2"],
  ["arm64", "arm64", "1.166.2"],
  ["x64", "x86_64", "1.140.0"],
  ["arm64", "arm64", "1.140.0"],
])(
  "cache hit whose archive matches the published digest is used (%s %s %s)",
  async (inputArch, expectedArch, version) => {
    jest.spyOn(os, "platform").mockReturnValue("linux");
    jest.spyOn(os, "arch").mockReturnValue(inputArch);
    process.env.ImageOS = "ubuntu24";

    useInstaller(version);
    mockRelease(`v${version}`, expectedArch, GOOD_SHA256);
    seedCache(version, expectedArch, GOOD_ARCHIVE);

    cache.restoreCache = jest.fn().mockResolvedValue("cache-key-hit");
    tc.extractZip = jest.fn().mockResolvedValue(undefined);
    tc.downloadTool = jest.fn();

    await setup();

    expect(cache.restoreCache).toHaveBeenCalledWith(
      [archivePathFor(version, expectedArch)],
      `sam-cli-verified-linux-ubuntu24-${expectedArch}-${version}`,
    );
    expect(tc.downloadTool).not.toHaveBeenCalled();
    expect(cache.saveCache).not.toHaveBeenCalled();
    expect(tc.extractZip).toHaveBeenCalledTimes(1);
    expect(core.setOutput).toHaveBeenCalledWith("cache-hit", true);
    expect(core.addPath).toHaveBeenCalledTimes(1);
    expect(core.setFailed).not.toHaveBeenCalled();
  },
);

test("cache entry that fails verification is ignored and the official archive is downloaded", async () => {
  jest.spyOn(os, "platform").mockReturnValue("linux");
  jest.spyOn(os, "arch").mockReturnValue("x64");
  process.env.ImageOS = "ubuntu24";

  useInstaller("1.166.2");
  mockRelease("v1.166.2", "x86_64", GOOD_SHA256);
  // The cache holds something other than the official archive.
  seedCache("1.166.2", "x86_64", OTHER_ARCHIVE);

  cache.restoreCache = jest.fn().mockResolvedValue("cache-key-hit");
  cache.saveCache = jest.fn().mockResolvedValue(1);
  tc.extractZip = jest.fn().mockResolvedValue(undefined);
  stubDownload(GOOD_ARCHIVE);

  await setup();

  expect(core.warning).toHaveBeenCalledWith(
    expect.stringContaining("does not match its published SHA256 digest"),
  );
  // Falls back to the official download rather than trusting the cache.
  expect(tc.downloadTool).toHaveBeenCalledWith(
    "https://github.com/aws/aws-sam-cli/releases/download/v1.166.2/aws-sam-cli-linux-x86_64.zip",
  );
  expect(core.setOutput).toHaveBeenCalledWith("cache-hit", false);
  expect(core.setOutput).not.toHaveBeenCalledWith("cache-hit", true);
  // The key is already taken by the entry that was just rejected, and entries
  // are immutable, so a save could only fail after archiving ~95 MB.
  expect(cache.saveCache).not.toHaveBeenCalled();
  expect(core.addPath).toHaveBeenCalledTimes(1);
  expect(core.setFailed).not.toHaveBeenCalled();
});

test("cache miss downloads, verifies, then caches the archive", async () => {
  jest.spyOn(os, "platform").mockReturnValue("linux");
  jest.spyOn(os, "arch").mockReturnValue("x64");
  process.env.ImageOS = "ubuntu24";

  useInstaller("1.166.2");
  mockRelease("v1.166.2", "x86_64", GOOD_SHA256);

  cache.restoreCache = jest.fn().mockResolvedValue(undefined);
  cache.saveCache = jest.fn().mockResolvedValue(1);
  tc.extractZip = jest.fn().mockResolvedValue(undefined);
  stubDownload(GOOD_ARCHIVE);

  await setup();

  expect(tc.downloadTool).toHaveBeenCalledTimes(1);
  expect(cache.saveCache).toHaveBeenCalledWith(
    [archivePathFor("1.166.2", "x86_64")],
    "sam-cli-verified-linux-ubuntu24-x86_64-1.166.2",
  );
  expect(core.addPath).toHaveBeenCalledTimes(1);
  expect(core.setFailed).not.toHaveBeenCalled();
});

test("downloaded archive that fails verification is not used or cached", async () => {
  jest.spyOn(os, "platform").mockReturnValue("linux");
  jest.spyOn(os, "arch").mockReturnValue("x64");
  process.env.ImageOS = "ubuntu24";

  useInstaller("1.166.2");
  mockRelease("v1.166.2", "x86_64", GOOD_SHA256);

  cache.restoreCache = jest.fn().mockResolvedValue(undefined);
  cache.saveCache = jest.fn().mockResolvedValue(1);
  tc.extractZip = jest.fn().mockResolvedValue(undefined);
  // The download itself does not match the published digest.
  stubDownload(OTHER_ARCHIVE);

  await setup();

  expect(core.setFailed).toHaveBeenCalledWith(
    expect.stringContaining("does not match its published SHA256 digest"),
  );
  expect(cache.saveCache).not.toHaveBeenCalled();
  expect(core.addPath).not.toHaveBeenCalled();
});

test.each([
  ["x64", "x86_64"],
  ["arm64", "arm64"],
])(
  "version without a published digest is downloaded without using the cache (%s)",
  async (inputArch, expectedArch) => {
    jest.spyOn(os, "platform").mockReturnValue("linux");
    jest.spyOn(os, "arch").mockReturnValue(inputArch);
    process.env.ImageOS = "ubuntu24";

    useInstaller("1.104.0");
    // Releases published before mid-2025 carry no asset digest.
    mockRelease("v1.104.0", expectedArch, null);

    cache.restoreCache = jest.fn();
    cache.saveCache = jest.fn();
    tc.extractZip = jest.fn().mockResolvedValue(undefined);
    stubDownload(GOOD_ARCHIVE);

    await setup();

    expect(cache.restoreCache).not.toHaveBeenCalled();
    expect(cache.saveCache).not.toHaveBeenCalled();
    expect(tc.downloadTool).toHaveBeenCalledWith(
      `https://github.com/aws/aws-sam-cli/releases/download/v1.104.0/aws-sam-cli-linux-${expectedArch}.zip`,
    );
    expect(core.setOutput).toHaveBeenCalledWith("cache-hit", false);
    expect(core.addPath).toHaveBeenCalledTimes(1);
    expect(core.setFailed).not.toHaveBeenCalled();
  },
);

test.each([
  ["not prefixed with sha256", "0".repeat(64)],
  ["a different algorithm", `sha512:${"0".repeat(64)}`],
  ["too short to be a sha256", "sha256:abc123"],
  ["not hex", `sha256:${"z".repeat(64)}`],
  ["empty", ""],
])(
  "digest that is %s is treated as unusable, so the cache is not used",
  async (_label, rawDigest) => {
    jest.spyOn(os, "platform").mockReturnValue("linux");
    jest.spyOn(os, "arch").mockReturnValue("x64");
    process.env.ImageOS = "ubuntu24";

    useInstaller("1.166.2");
    jest.spyOn(httpm.HttpClient.prototype, "get").mockResolvedValue({
      message: { statusCode: 200 },
      readBody: () =>
        JSON.stringify({
          tag_name: "v1.166.2",
          assets: [{ name: "aws-sam-cli-linux-x86_64.zip", digest: rawDigest }],
        }),
    });

    cache.restoreCache = jest.fn();
    cache.saveCache = jest.fn();
    tc.extractZip = jest.fn().mockResolvedValue(undefined);
    stubDownload(GOOD_ARCHIVE);

    await setup();

    // An unparseable digest is no digest at all: there is nothing to verify
    // against, so the cache must be bypassed rather than trusted.
    expect(cache.restoreCache).not.toHaveBeenCalled();
    expect(cache.saveCache).not.toHaveBeenCalled();
    expect(core.addPath).toHaveBeenCalledTimes(1);
    expect(core.setFailed).not.toHaveBeenCalled();
  },
);

test("warning for a rejected entry says it is ignored and how to clear it", async () => {
  jest.spyOn(os, "platform").mockReturnValue("linux");
  jest.spyOn(os, "arch").mockReturnValue("x64");
  process.env.ImageOS = "ubuntu24";

  useInstaller("1.166.2");
  mockRelease("v1.166.2", "x86_64", GOOD_SHA256);
  seedCache("1.166.2", "x86_64", OTHER_ARCHIVE);

  cache.restoreCache = jest.fn().mockResolvedValue("cache-key-hit");
  cache.saveCache = jest.fn();
  tc.extractZip = jest.fn().mockResolvedValue(undefined);
  stubDownload(GOOD_ARCHIVE);

  await setup();

  const key = "sam-cli-verified-linux-ubuntu24-x86_64-1.166.2";

  // The entry is ignored, not discarded: it cannot be overwritten and will be
  // restored and rejected on every run, so the warning must say how to clear it.
  const mismatchWarning = core.warning.mock.calls
    .map(([message]) => String(message))
    .find((message) => message.includes("does not match its published"));
  expect(mismatchWarning).toBeDefined();
  expect(mismatchWarning).not.toMatch(/discard/i);
  expect(mismatchWarning).toContain(`gh cache delete '${key}'`);
});

test("save that the cache service declines is not reported as a success", async () => {
  jest.spyOn(os, "platform").mockReturnValue("linux");
  jest.spyOn(os, "arch").mockReturnValue("x64");
  process.env.ImageOS = "ubuntu24";

  useInstaller("1.166.2");
  mockRelease("v1.166.2", "x86_64", GOOD_SHA256);

  cache.restoreCache = jest.fn().mockResolvedValue(undefined);
  // What @actions/cache actually does when it cannot save (key already
  // reserved, read-only cache, service error): log the reason itself and
  // return -1. It does not throw.
  cache.saveCache = jest.fn().mockResolvedValue(-1);
  tc.extractZip = jest.fn().mockResolvedValue(undefined);
  stubDownload(GOOD_ARCHIVE);

  await setup();

  const infos = core.info.mock.calls.map(([message]) => String(message));
  expect(infos).toContain(
    "AWS SAM CLI 1.166.2 was not saved to the GitHub Actions cache",
  );
  expect(infos).not.toContain(
    "Cached AWS SAM CLI 1.166.2 to GitHub Actions cache",
  );
  // -1 has several unrelated causes, so it must not be blamed on an existing
  // entry or come with advice to delete one.
  const messages = [
    ...infos,
    ...core.warning.mock.calls.map(([m]) => String(m)),
  ];
  expect(messages.some((m) => m.includes("gh cache delete"))).toBe(false);
  // The run still succeeds on the verified download.
  expect(core.addPath).toHaveBeenCalledTimes(1);
  expect(core.setFailed).not.toHaveBeenCalled();
});

test("save that fails validation is reported as a warning and does not fail the run", async () => {
  jest.spyOn(os, "platform").mockReturnValue("linux");
  jest.spyOn(os, "arch").mockReturnValue("x64");
  process.env.ImageOS = "ubuntu24";

  useInstaller("1.166.2");
  mockRelease("v1.166.2", "x86_64", GOOD_SHA256);

  cache.restoreCache = jest.fn().mockResolvedValue(undefined);
  // ValidationError is the one error saveCache rethrows.
  const validationError = new Error("Key Validation Error");
  validationError.name = "ValidationError";
  cache.saveCache = jest.fn().mockRejectedValue(validationError);
  tc.extractZip = jest.fn().mockResolvedValue(undefined);
  stubDownload(GOOD_ARCHIVE);

  await setup();

  expect(core.warning).toHaveBeenCalledWith(
    expect.stringContaining("Key Validation Error"),
  );
  expect(core.addPath).toHaveBeenCalledTimes(1);
  expect(core.setFailed).not.toHaveBeenCalled();
});

test("release metadata lookup failure falls back to an uncached download", async () => {
  jest.spyOn(os, "platform").mockReturnValue("linux");
  jest.spyOn(os, "arch").mockReturnValue("x64");
  process.env.ImageOS = "ubuntu24";

  useInstaller("1.166.2");
  jest
    .spyOn(httpm.HttpClient.prototype, "get")
    .mockRejectedValue(new Error("Mocked exception"));

  cache.restoreCache = jest.fn();
  cache.saveCache = jest.fn();
  tc.extractZip = jest.fn().mockResolvedValue(undefined);
  stubDownload(GOOD_ARCHIVE);

  await setup();

  expect(cache.restoreCache).not.toHaveBeenCalled();
  expect(cache.saveCache).not.toHaveBeenCalled();
  expect(tc.downloadTool).toHaveBeenCalledWith(
    "https://github.com/aws/aws-sam-cli/releases/download/v1.166.2/aws-sam-cli-linux-x86_64.zip",
  );
  expect(core.addPath).toHaveBeenCalledTimes(1);
});

test.each([
  ["x64", "x86_64"],
  ["arm64", "arm64"],
])(
  "no version specified resolves latest and caches the verified archive (%s)",
  async (inputArch, expectedArch) => {
    jest.spyOn(os, "platform").mockReturnValue("linux");
    jest.spyOn(os, "arch").mockReturnValue(inputArch);
    process.env.ImageOS = "ubuntu24";

    useInstaller("");
    mockRelease("v1.166.2", expectedArch, GOOD_SHA256);

    cache.restoreCache = jest.fn().mockResolvedValue(undefined);
    cache.saveCache = jest.fn().mockResolvedValue(1);
    tc.extractZip = jest.fn().mockResolvedValue(undefined);
    stubDownload(GOOD_ARCHIVE);

    await setup();

    expect(tc.downloadTool).toHaveBeenCalledWith(
      `https://github.com/aws/aws-sam-cli/releases/download/v1.166.2/aws-sam-cli-linux-${expectedArch}.zip`,
    );
    expect(cache.saveCache).toHaveBeenCalledWith(
      [archivePathFor("1.166.2", expectedArch)],
      `sam-cli-verified-linux-ubuntu24-${expectedArch}-1.166.2`,
    );
    expect(core.addPath).toHaveBeenCalledTimes(1);
  },
);

test.each([
  {
    arch: "x64",
    input: { token: undefined },
    expected: { headers: undefined },
  },
  {
    arch: "x64",
    input: { token: "" },
    expected: { headers: undefined },
  },
  {
    arch: "x64",
    input: { token: "1234abc" },
    expected: { headers: { Authorization: "Bearer 1234abc" } },
  },
])("github api request %o", async (test) => {
  jest.spyOn(os, "platform").mockReturnValue("linux");
  jest.spyOn(os, "arch").mockReturnValue(test.arch);
  process.env.ImageOS = "ubuntu24";

  core.getBooleanInput = jest.fn().mockReturnValue(true);
  core.getInput = jest
    .fn()
    .mockReturnValueOnce("")
    .mockReturnValueOnce("python3")
    .mockReturnValueOnce(test.input.token);

  const getMock = mockRelease("v1.166.2", "x86_64", GOOD_SHA256);

  cache.restoreCache = jest.fn().mockResolvedValue(undefined);
  cache.saveCache = jest.fn().mockResolvedValue(1);
  tc.extractZip = jest.fn().mockResolvedValue(undefined);
  stubDownload(GOOD_ARCHIVE);

  await setup();

  expect(getMock).toHaveBeenCalledWith(
    expect.anything(),
    test.expected.headers,
  );
  expect(core.addPath).toHaveBeenCalledTimes(1);
});

test.each([
  ["x64", "x86_64"],
  ["arm64", "arm64"],
])(
  "latest release lookup failure downloads latest without caching (%s)",
  async (inputArch, expectedArch) => {
    jest.spyOn(os, "platform").mockReturnValue("linux");
    jest.spyOn(os, "arch").mockReturnValue(inputArch);

    useInstaller("");
    jest
      .spyOn(httpm.HttpClient.prototype, "get")
      .mockRejectedValue(new Error("Mocked exception"));

    cache.restoreCache = jest.fn();
    cache.saveCache = jest.fn();
    tc.extractZip = jest.fn().mockResolvedValue(undefined);
    stubDownload(GOOD_ARCHIVE);

    await setup();

    expect(tc.downloadTool).toHaveBeenCalledWith(
      `https://github.com/aws/aws-sam-cli/releases/latest/download/aws-sam-cli-linux-${expectedArch}.zip`,
    );
    expect(cache.restoreCache).not.toHaveBeenCalled();
    expect(cache.saveCache).not.toHaveBeenCalled();
    expect(core.addPath).toHaveBeenCalledTimes(1);
  },
);

test("version too old for ARM fails before any download or cache access", async () => {
  jest.spyOn(os, "platform").mockReturnValue("linux");
  jest.spyOn(os, "arch").mockReturnValue("arm64");

  useInstaller("1.103.0");
  mockRelease("v1.103.0", "arm64", GOOD_SHA256);

  cache.restoreCache = jest.fn();
  tc.downloadTool = jest.fn();

  await setup();

  expect(core.setFailed).toHaveBeenCalledWith(
    "ARM64 installer is only available for versions 1.104.0 and above",
  );
  expect(tc.downloadTool).not.toHaveBeenCalled();
  expect(cache.restoreCache).not.toHaveBeenCalled();
});

test.each([["x64"], ["arm64"]])(
  "version not in x.y.z format is neither downloaded nor looked up in cache (%s)",
  async (inputArch) => {
    jest.spyOn(os, "platform").mockReturnValue("linux");
    jest.spyOn(os, "arch").mockReturnValue(inputArch);

    core.getBooleanInput = jest.fn().mockReturnValue(true);
    cache.restoreCache = jest.fn();
    tc.downloadTool = jest.fn();

    for (const version of ["1.2", "1.*", "3"]) {
      core.getInput = jest.fn().mockReturnValueOnce(version);
      await setup();
      expect(tc.downloadTool).not.toHaveBeenCalled();
      expect(cache.restoreCache).not.toHaveBeenCalled();
    }
  },
);
