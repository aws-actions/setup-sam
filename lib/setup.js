const fs = require("fs");
const path = require("path");
const os = require("os");

const core = require("@actions/core");
const exec = require("@actions/exec");
const io = require("@actions/io");

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "tmp-"));
}

/**
 * Creates a Python virtual environment.
 *
 * @param {string} python - The Python interpreter to use.
 * @returns {Promise<string>} The path to the virtual environment.
 */
async function createPythonVenv(python) {
  const venvPath = mkdirTemp();
  const pythonPath = await io.which(python, true);

  await exec.exec(pythonPath, ["--version"]);
  await exec.exec(pythonPath, ["-m", "venv", venvPath]);

  return venvPath;
}

/**
 * Installs SAM CLI.
 *
 * @param {string} python - The Python interpreter to use for SAM CLI.
 * @param {string} version - The SAM CLI version to install.
 * @returns {Promise<string>} The directory SAM CLI is installed in.
 */
async function installSamCli(python, version) {
  const venvPath = await createPythonVenv(python);

  // See https://docs.python.org/3/library/venv.html
  const binDir = isWindows() ? "Scripts" : "bin";
  const binPath = path.join(venvPath, binDir);

  const pipPath = path.join(binPath, "pip");

  // Required to install from source and binary distributions
  await exec.exec(pipPath, ["install", "setuptools", "wheel"]);
  // Install latest compatible version
  await exec.exec(pipPath, ["install", "--upgrade", `aws-sam-cli==${version}`]);

  return binPath;
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

async function setup() {
  const version = getInput("version", /^[\d.*]+$/, "1.*");
  // python3 isn't standard on Windows
  const defaultPython = isWindows() ? "python" : "python3";
  const python = getInput("python", /^.+$/, defaultPython);

  const binPath = await installSamCli(python, version);
  core.addPath(binPath);
}

module.exports = setup;
