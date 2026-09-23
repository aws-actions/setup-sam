const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const core = require("@actions/core");
const exec = require("@actions/exec");
const io = require("@actions/io");
const tc = require("@actions/tool-cache");
const cache = require("@actions/cache");
const httpm = require("@actions/http-client");
const semverLt = require("semver/functions/lt");
/**
 * Returns whether the current platform is Windows.
 */
function isWindows() {
  return os.platform() === "win32";
}

/**
 * Returns a new temporary directory.
 */
function mkdirTemp() {
  const tempDir = process.env.RUNNER_TEMP || os.tmpdir();
  return fs.mkdtempSync(path.join(tempDir, "setup-sam-"));
}

/**
 * Creates a Python virtual environment.
 *
 * @param {string} python - The Python interpreter to use.
 * @param {string} venvPath - The virtual environment directory.
 */
async function createPythonVenv(python, venvPath) {
  const pythonPath = await io.which(python, true);

  await exec.exec(pythonPath, ["--version"]);
  await exec.exec(pythonPath, ["-m", "venv", venvPath]);
}

/**
 * Installs SAM CLI.
 *
 * @param {string} python - The Python interpreter to use for SAM CLI.
 * @param {string} version - The SAM CLI version to install.
 * @returns {Promise<string>} The directory SAM CLI is installed in.
 */
async function installSamCli(python, version) {
  const tempPath = mkdirTemp();

  // Create virtual environment
  const venvPath = path.join(tempPath, ".venv");
  await createPythonVenv(python, venvPath);

  // See https://docs.python.org/3/library/venv.html
  const binDir = isWindows() ? "Scripts" : "bin";
  const binPath = path.join(venvPath, binDir);

  // Virtual environment Python
  const pythonPath = path.join(binPath, "python");

  // Ensure installation tooling is up-to-date across platforms
  // setuptools and wheel needed for source and binary distributions
  await exec.exec(pythonPath, ["-m", "pip", "install", "--upgrade", "pip"]);
  await exec.exec(pythonPath, [
    "-m",
    "pip",
    "install",
    "--upgrade",
    "setuptools",
    "wheel",
  ]);

  // Install latest compatible version
  if (!version) {
    version = "1.*";
  }
  // NOTE: cython 3.0.0 breaking installation of pyyaml - https://github.com/yaml/pyyaml/issues/724
  await exec.exec(pythonPath, [
    "-m",
    "pip",
    "install",
    "cython<3.0.0",
    "pyyaml==5.4.1",
    "--no-build-isolation",
  ]);
  await exec.exec(pythonPath, [
    "-m",
    "pip",
    "install",
    "--upgrade",
    `aws-sam-cli==${version}`,
  ]);

  // Symlink from separate directory so only SAM CLI is added to PATH
  const symlinkPath = path.join(tempPath, "bin");
  fs.mkdirSync(symlinkPath);
  const sam = isWindows() ? "sam.exe" : "sam";
  fs.symlinkSync(path.join(binPath, sam), path.join(symlinkPath, sam));

  return symlinkPath;
}

/**
 * Gets an input value.
 *
 * @param {string} name - The input value name.
 * @param {RegExp} pattern - The input value pattern.
 * @param {string} defaultValue - The default value if the input value is empty.
 * @returns {string} The input value.
 * @throws {Error} Throws if the input value doesn't match `pattern`.
 */
function getInput(name, pattern, defaultValue) {
  const value = core.getInput(name) || defaultValue;
  if (!pattern.test(value)) {
    throw new Error(`${name} doesn't match ${pattern}`);
  }
  return value;
}

/**
 * Returns whether a string is in the format x.y.z.
 */
function isSemver(s) {
  return /^\d+\.\d+\.\d+$/.test(s);
}

/**
 * The cache key prefix.
 *
 * Earlier versions of this action cached the extracted install directory and
 * trusted it without verification. This action caches the release archive
 * instead and checks it against the digest published on the GitHub release
 * before use. The prefix records that entries under it are only ever consumed
 * after verification, and keeps entries written by the previous, unverified
 * layout - including any that were tampered with - from being restored here.
 */
const CACHE_KEY_PREFIX = "sam-cli-verified";

/**
 * Returns the release archive name for an architecture.
 *
 * @param {string} arch - The architecture (x86_64 or arm64).
 */
function archiveName(arch) {
  return `aws-sam-cli-linux-${arch}.zip`;
}

/**
 * Fetches release metadata from the GitHub API.
 *
 * @param {string} url - The release API URL.
 * @param {string} token - Authentication Token to use for GITHUB Apis.
 * @returns {Promise<object>} The parsed release payload.
 * @throws {Error} Throws if the request fails.
 */
async function fetchRelease(url, token) {
  const client = new httpm.HttpClient("setup-sam");
  let httpHeaders = undefined;

  // By default, GITHUB API calls will be made as unauthenticated requests. If
  // token is present, it will be made as authenticated requests.
  if (token) {
    httpHeaders = {
      Authorization: `Bearer ${token}`,
    };
  }

  const response = await client.get(url, httpHeaders);
  if (response.message.statusCode !== 200) {
    throw new Error(
      `Failed to fetch data: ${response.message.statusCode} ${response.message.statusMessage}`,
    );
  }

  return JSON.parse(await response.readBody());
}

/**
 * Get the latest SAM CLI release from
 * https://api.github.com/repos/aws/aws-sam-cli/releases/latest
 *
 * @param {string} token - Authentication Token to use for GITHUB Apis.
 * @returns {Promise<object|null>} The release payload, or null on failure.
 */
async function getLatestRelease(token) {
  const url = "https://api.github.com/repos/aws/aws-sam-cli/releases/latest";

  try {
    return await fetchRelease(url, token);
  } catch (error) {
    core.warning("Unable to get SAM CLI's latest release tag ", error);
    return null;
  }
}

/**
 * Get a specific SAM CLI release by tag.
 *
 * @param {string} version - The SAM CLI version (x.y.z).
 * @param {string} token - Authentication Token to use for GITHUB Apis.
 * @returns {Promise<object|null>} The release payload, or null on failure.
 */
async function getReleaseByTag(version, token) {
  const url = `https://api.github.com/repos/aws/aws-sam-cli/releases/tags/v${version}`;

  try {
    return await fetchRelease(url, token);
  } catch (error) {
    core.warning(
      `Unable to get release metadata for v${version}: ${error.message}`,
    );
    return null;
  }
}

/**
 * Extracts the published SHA256 digest of the release archive.
 *
 * GitHub only populates the asset `digest` field for releases published after
 * mid-2025, so this returns an empty string for older versions.
 *
 * @param {object} release - The release payload.
 * @param {string} arch - The architecture (x86_64 or arm64).
 * @returns {string} The lowercase hex digest, or "" when unavailable.
 */
function publishedSha256(release, arch) {
  if (!release || !Array.isArray(release.assets)) {
    return "";
  }

  const asset = release.assets.find((a) => a.name === archiveName(arch));
  if (!asset || !asset.digest) {
    return "";
  }

  const match = /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest).trim());
  return match ? match[1].toLowerCase() : "";
}

/**
 * Computes the SHA256 digest of a file.
 *
 * @param {string} filePath - The file to hash.
 * @returns {Promise<string>} The lowercase hex digest.
 */
function fileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Verifies an archive against the published digest.
 *
 * @param {string} archivePath - The archive to verify.
 * @param {string} expectedSha256 - The expected lowercase hex digest.
 * @returns {Promise<boolean>} Whether the archive matches.
 */
async function verifyArchive(archivePath, expectedSha256) {
  try {
    const actual = await fileSha256(archivePath);
    if (actual === expectedSha256) {
      return true;
    }
    core.warning(
      `SHA256 mismatch: expected ${expectedSha256}, calculated ${actual}`,
    );
    return false;
  } catch (error) {
    core.warning(`Unable to verify archive: ${error.message}`);
    return false;
  }
}

/**
 * Extracts an archive to a new temporary directory.
 *
 * @param {string} archivePath - The archive to extract.
 * @returns {Promise<string>} The directory SAM CLI is installed in.
 */
async function extractArchive(archivePath) {
  const tempDir = mkdirTemp();
  await tc.extractZip(archivePath, tempDir);
  return path.join(tempDir, "dist");
}

/**
 * Downloads SAM CLI, verifies it, and caches the verified archive.
 *
 * @param {string} version - The SAM CLI version.
 * @param {string} arch - The architecture (x86_64 or arm64).
 * @param {string} expectedSha256 - The expected lowercase hex digest.
 * @param {string} archivePath - Where to store the archive.
 * @param {string} cacheKey - The cache key.
 * @returns {Promise<string>} The directory SAM CLI is installed in.
 */
async function downloadVerifyAndCache(
  version,
  arch,
  expectedSha256,
  archivePath,
  cacheKey,
) {
  const url = `https://github.com/aws/aws-sam-cli/releases/download/v${version}/${archiveName(arch)}`;

  try {
    const toolPath = await tc.downloadTool(url);
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.copyFileSync(toolPath, archivePath);

    if (!(await verifyArchive(archivePath, expectedSha256))) {
      core.setFailed(
        `Downloaded AWS SAM CLI ${version} does not match its published SHA256 digest. Refusing to use it.`,
      );
      return "";
    }

    const binDir = await extractArchive(archivePath);

    try {
      await cache.saveCache([archivePath], cacheKey);
      core.info(`Cached AWS SAM CLI ${version} to GitHub Actions cache`);
    } catch (error) {
      core.warning(`Failed to save to cache: ${error.message}`);
    }

    return binDir;
  } catch (error) {
    core.warning(`Failed to download SAM CLI: ${error.message}`);
    return "";
  }
}

/**
 * Downloads SAM CLI without caching it.
 *
 * Used when no published digest is available to verify against, so the archive
 * must not be trusted across runs.
 *
 * @param {string} arch - The architecture (x86_64 or arm64).
 * @param {string} [version] - The SAM CLI version; latest when omitted.
 * @returns {Promise<string>} The directory SAM CLI is installed in.
 */
async function downloadWithoutCache(arch, version) {
  const url = version
    ? `https://github.com/aws/aws-sam-cli/releases/download/v${version}/${archiveName(arch)}`
    : `https://github.com/aws/aws-sam-cli/releases/latest/download/${archiveName(arch)}`;
  const tempDir = mkdirTemp();

  try {
    const toolPath = await tc.downloadTool(url);
    await tc.extractZip(toolPath, tempDir);
    return path.join(tempDir, "dist");
  } catch (error) {
    core.warning(`Failed to download SAM CLI: ${error.message}`);
    return "";
  }
}

/**
 * Installs SAM CLI using the native installers.
 *
 * See https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html
 *
 * @param {string} inputVersion - The SAM CLI version to install.
 * @param {string} token - Authentication Token to use for GITHUB Apis.
 * @returns {Promise<string>} The directory SAM CLI is installed in.
 */
// TODO: Support more platforms
async function installUsingNativeInstaller(inputVersion, token) {
  // Validate platform
  if (os.platform() !== "linux") {
    core.setFailed("Only Linux is supported with use-installer: true");
    return "";
  }

  if (os.arch() !== "x64" && os.arch() !== "arm64") {
    core.setFailed(
      "Only x86-64 and aarch64 architectures are supported with use-installer: true",
    );
    return "";
  }

  // Validate version format
  if (inputVersion && !isSemver(inputVersion)) {
    core.setFailed("Version must be in the format x.y.z");
    return "";
  }

  const arch = os.arch() === "arm64" ? "arm64" : "x86_64";

  // Determine version, and fetch the release metadata we need for the
  // integrity check in the same request.
  let version = inputVersion;
  let release = null;
  if (version) {
    release = await getReleaseByTag(version, token);
  } else {
    release = await getLatestRelease(token);
    const tag =
      release && typeof release.tag_name === "string"
        ? release.tag_name.substring(1)
        : "";
    if (isSemver(tag)) {
      version = tag;
    } else {
      core.info(
        "Unable to determine version. Downloading latest without caching.",
      );
      // Set version to empty to skip caching below
      version = "";
    }
  }

  // Validate ARM64 version requirement
  if (version && os.arch() === "arm64" && semverLt(version, "1.104.0")) {
    core.setFailed(
      "ARM64 installer is only available for versions 1.104.0 and above",
    );
    return "";
  }

  // Download without caching (no version)
  if (!version) {
    return await downloadWithoutCache(arch);
  }

  // Only cache what we can verify. Restored cache content is writable by
  // anything that can write to a cache scope the job reads, so without a
  // published digest to check it against there is no safe way to trust it.
  const expectedSha256 = publishedSha256(release, arch);
  if (!expectedSha256) {
    core.info(
      `No published SHA256 digest is available for v${version}, so the GitHub Actions cache cannot be used safely. Downloading the official archive instead.`,
    );
    return await downloadWithoutCache(arch, version);
  }

  // Include ImageOS in cache key to isolate caches between runner images
  const imageOS = process.env.ImageOS || "unknown";
  const cacheKey = `${CACHE_KEY_PREFIX}-${os.platform()}-${imageOS}-${arch}-${version}`;
  const archivePath = path.join(
    os.homedir(),
    ".sam-cli-cache",
    version,
    archiveName(arch),
  );

  try {
    const cacheHit = await cache.restoreCache([archivePath], cacheKey);
    if (cacheHit) {
      if (await verifyArchive(archivePath, expectedSha256)) {
        core.info(
          `Using cached AWS SAM CLI ${version} from GitHub Actions cache`,
        );
        core.setOutput("cache-hit", true);
        return await extractArchive(archivePath);
      }
      core.warning(
        `Cached AWS SAM CLI ${version} does not match its published SHA256 digest. Discarding the cache entry and downloading the official archive.`,
      );
    }
  } catch (error) {
    core.warning(`Failed to restore from cache: ${error.message}`);
  }

  return await downloadVerifyAndCache(
    version,
    arch,
    expectedSha256,
    archivePath,
    cacheKey,
  );
}

async function setup() {
  const version = getInput("version", /^[\d.*]*$/, "");
  // python3 isn't standard on Windows
  const defaultPython = isWindows() ? "python" : "python3";
  const python = getInput("python", /^.+$/, defaultPython);
  const useInstaller = core.getBooleanInput("use-installer");
  const token = getInput("token", /^.*$/, "");

  core.setOutput("cache-hit", false);

  const binPath = useInstaller
    ? await installUsingNativeInstaller(version, token)
    : await installSamCli(python, version);

  if (binPath) {
    core.addPath(binPath);
  }
}

module.exports = setup;
