const fs = require("fs");
const path = require("path");
const os = require("os");

const core = require("@actions/core");
const exec = require("@actions/exec");
const io = require("@actions/io");
const tc = require("@actions/tool-cache");
const httpm = require("@actions/http-client");
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
 */
async function getLatestReleaseTag() {
  const url = "https://api.github.com/repos/aws/aws-sam-cli/releases/latest";
  const client = new httpm.HttpClient("setup-sam");
  try {
    const response = await client.get(url);
    if (response.message.statusCode !== 200) {
      throw new Error(
        `Failed to fetch data: ${response.message.statusCode} ${response.message.statusMessage}`
      );
    }

    const data = JSON.parse(await response.readBody());
    return data.tag_name.substring(1);
  } catch (error) {
    core.setFailed("Error:", error);
    return "";
  }
}

/**
 * Installs SAM CLI using the native installers.
 *
 * See https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html
 *
 * @param {string} version - The SAM CLI version to install.
 * @returns {Promise<string>} The directory SAM CLI is installed in.
 */
// TODO: Support more platforms
async function installUsingNativeInstaller(inputVersion) {
  if (os.platform() !== "linux" || os.arch() !== "x64") {
    core.setFailed("Only Linux x86-64 is supported with use-installer: true");
    return "";
  }

  // Must be full semantic version; downloads version directly from GitHub
  if (inputVersion && !isSemver(inputVersion)) {
    core.setFailed("Version must be in the format x.y.z");
    return "";
  }

  let version = inputVersion;
  if (!version) {
    const latestVersion = await getLatestReleaseTag("aws/aws-sam-cli");
    // Must be full semantic version; downloads version directly from GitHub
    if (latestVersion && !isSemver(latestVersion)) {
      core.info(
        "Fetched version is not in the format x.y.z. Use latest version without caching."
      );
      return "";
    }
    version = latestVersion;
  }

  if (version) {
    const cachedDir = tc.find("sam", version);
    if (cachedDir) {
      core.info(`Using cached AWS SAM CLI ${version} from ${cachedDir}`);
      return path.join(cachedDir, "dist");
    }
  }

  const url = version
    ? `https://github.com/aws/aws-sam-cli/releases/download/v${version}/aws-sam-cli-linux-x86_64.zip`
    : "https://github.com/aws/aws-sam-cli/releases/latest/download/aws-sam-cli-linux-x86_64.zip";

  const toolPath = await tc.downloadTool(url);
  const extractedDir = await tc.extractZip(toolPath);
  const binDir = path.join(extractedDir, "dist");

  if (version) {
    const cachedDir = await tc.cacheDir(extractedDir, "sam", version);
    core.info(`Cached AWS SAM CLI ${version} to ${cachedDir}`);
    return path.join(cachedDir, "dist");
  }

  return binDir;
}

async function setup() {
  const version = getInput("version", /^[\d.*]*$/, "");
  // python3 isn't standard on Windows
  const defaultPython = isWindows() ? "python" : "python3";
  const python = getInput("python", /^.+$/, defaultPython);
  const useInstaller = core.getBooleanInput("use-installer");

  const binPath = useInstaller
    ? await installUsingNativeInstaller(version)
    : await installSamCli(python, version);
  core.addPath(binPath);
}

module.exports = setup;
