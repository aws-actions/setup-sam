const fs = require("fs");
const path = require("path");
const os = require("os");

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
 * Get latest SAM CLI version from https://api.github.com/repos/aws/aws-sam-cli/releases/latest
 *
 * @param {string} token - Authentication Token to use for GITHUB Apis.
 */
async function getLatestReleaseTag(token) {
  const url = "https://api.github.com/repos/aws/aws-sam-cli/releases/latest";
  const client = new httpm.HttpClient("setup-sam");
  let httpHeaders = undefined;

  try {
    //By default, GITHUB API calls will be made as unauthenticated requests. If token is present, it will be made as authenticated requests.
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

    const data = JSON.parse(await response.readBody());
    return data.tag_name.substring(1);
  } catch (error) {
    core.warning("Unable to get SAM CLI's latest release tag ", error);
    return "";
  }
}

/**
 * Downloads and caches SAM CLI.
 *
 * @param {string} version - The SAM CLI version.
 * @param {string} arch - The architecture (x86_64 or arm64).
 * @param {string} installDir - The installation directory.
 * @param {string} cacheKey - The cache key.
 * @returns {Promise<string>} The directory SAM CLI is installed in.
 */
async function downloadAndCache(version, arch, installDir, cacheKey) {
  const url = `https://github.com/aws/aws-sam-cli/releases/download/v${version}/aws-sam-cli-linux-${arch}.zip`;

  try {
    const toolPath = await tc.downloadTool(url);
    await tc.extractZip(toolPath, installDir);
    const binDir = path.join(installDir, "dist");

    try {
      await cache.saveCache([installDir], cacheKey);
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
 * Downloads SAM CLI without caching.
 *
 * @param {string} arch - The architecture (x86_64 or arm64).
 * @returns {Promise<string>} The directory SAM CLI is installed in.
 */
async function downloadWithoutCache(arch) {
  const url = `https://github.com/aws/aws-sam-cli/releases/latest/download/aws-sam-cli-linux-${arch}.zip`;
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

  // Determine version
  let version = inputVersion;
  if (!version) {
    version = await getLatestReleaseTag(token);
    if (!version || !isSemver(version)) {
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

  const arch = os.arch() === "arm64" ? "arm64" : "x86_64";

  // Try cache if we have a version
  if (version) {
    const cacheKey = `sam-cli-${os.platform()}-${arch}-${version}`;
    const installDir = path.join(os.homedir(), ".sam-cli-cache", version);

    try {
      const cacheHit = await cache.restoreCache([installDir], cacheKey);
      if (cacheHit) {
        core.info(
          `Using cached AWS SAM CLI ${version} from GitHub Actions cache`,
        );
        return path.join(installDir, "dist");
      }
    } catch (error) {
      core.warning(`Failed to restore from cache: ${error.message}`);
    }

    // Download and cache
    return await downloadAndCache(version, arch, installDir, cacheKey);
  }

  // Download without caching (no version)
  return await downloadWithoutCache(arch);
}

async function setup() {
  const version = getInput("version", /^[\d.*]*$/, "");
  // python3 isn't standard on Windows
  const defaultPython = isWindows() ? "python" : "python3";
  const python = getInput("python", /^.+$/, defaultPython);
  const useInstaller = core.getBooleanInput("use-installer");
  const token = getInput("token", /^.*$/, "");

  const binPath = useInstaller
    ? await installUsingNativeInstaller(version, token)
    : await installSamCli(python, version);

  if (binPath) {
    core.addPath(binPath);
  }
}

module.exports = setup;
