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

const NIGHTLY = "nightly";
const NIGHTLY_TAG = "sam-cli-nightly";

/**
 * Returns whether a version string requests the nightly release.
 */
function isNightly(version) {
  return version === NIGHTLY;
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
 * @param {string} releaseTag - Optional release tag (e.g. "sam-cli-nightly"). Defaults to latest.
 * @returns {Promise<string>} The directory SAM CLI is installed in.
 */
async function downloadWithoutCache(arch, releaseTag) {
  const tagSegment = releaseTag ? `download/${releaseTag}` : "latest/download";
  const url = `https://github.com/aws/aws-sam-cli/releases/${tagSegment}/aws-sam-cli-linux-${arch}.zip`;
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
 * Builds the URL to the Windows MSI asset for a given release tag or version.
 *
 * @param {string} tagOrVersion - Either a release tag (e.g. "sam-cli-nightly")
 *   or an empty string to use the "latest" alias.
 * @param {boolean} isTag - True if the first arg is a release tag, false if version (x.y.z).
 */
function windowsMsiUrl(tagOrVersion, isTag) {
  const asset = "AWS_SAM_CLI_64_PY3.msi";
  if (!tagOrVersion) {
    return `https://github.com/aws/aws-sam-cli/releases/latest/download/${asset}`;
  }
  const tag = isTag ? tagOrVersion : `v${tagOrVersion}`;
  return `https://github.com/aws/aws-sam-cli/releases/download/${tag}/${asset}`;
}

/**
 * Runs the MSI silently via msiexec. Throws on failure.
 *
 * @param {string} msiPath - Path to the downloaded MSI.
 */
async function runMsiExec(msiPath) {
  // 3010 = ERROR_SUCCESS_REBOOT_REQUIRED; treat as success
  const logPath = path.join(mkdirTemp(), "msi-install.log");
  const exitCode = await exec.exec(
    "msiexec",
    ["/i", msiPath, "/qn", "/norestart", "/l*v", logPath],
    { ignoreReturnCode: true },
  );
  if (exitCode !== 0 && exitCode !== 3010) {
    if (fs.existsSync(logPath)) {
      const tail = fs.readFileSync(logPath, "utf8").split("\n").slice(-30);
      core.warning(
        `msiexec failed (${exitCode}); last log lines:\n${tail.join("\n")}`,
      );
    }
    throw new Error(`msiexec failed with exit code ${exitCode}`);
  }
}

/**
 * Returns the MSI install root for the given SAM CLI flavor.
 *
 * Stable installs to `C:\Program Files\Amazon\AWSSAMCLI`; nightly installs
 * to `C:\Program Files\Amazon\AWSSAMCLI_NIGHTLY`.
 *
 * @param {boolean} nightly - Whether to return the nightly path.
 */
function windowsSamInstallRoot(nightly) {
  const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
  return path.join(
    programFiles,
    "Amazon",
    nightly ? "AWSSAMCLI_NIGHTLY" : "AWSSAMCLI",
  );
}

/**
 * Locates the SAM CLI bin directory created by the MSI install.
 *
 * @param {boolean} nightly - Whether the nightly MSI was installed.
 */
function findWindowsSamBinDir(nightly) {
  const dir = path.join(windowsSamInstallRoot(nightly), "bin");
  if (!fs.existsSync(dir)) {
    throw new Error(`Expected SAM CLI install directory not found: ${dir}`);
  }
  return dir;
}

/**
 * Uninstalls any existing AWS SAM CLI MSI whose install root matches the
 * flavor we're about to install (stable or nightly).
 *
 * Windows Installer rejects silent downgrades, so if a newer SAM CLI is
 * already installed (e.g. GitHub-hosted Windows runners ship a recent stable,
 * or a previous step in the same workflow installed one), `msiexec /i` for
 * an older or equal pinned version fails with exit 1603. Removing the
 * existing product first makes the install order- and version-independent.
 *
 * Best-effort: logs and continues on any uninstall failure — the subsequent
 * `msiexec /i` will surface the real error if it can't proceed.
 *
 * @param {boolean} nightly - Whether to remove the nightly product.
 */
async function uninstallExistingWindowsSamCli(nightly) {
  // Match by DisplayName rather than InstallLocation: the SAM CLI MSI does
  // not populate ARPINSTALLLOCATION, so the registry's InstallLocation field
  // is empty for stable AND nightly. The DisplayName is reliable — stable is
  // "AWS SAM Command Line Interface", nightly is the same with " Nightly".
  // We still gate on the install root existing to skip the powershell
  // invocation entirely on a clean machine.
  const installRoot = windowsSamInstallRoot(nightly);
  if (!fs.existsSync(installRoot)) {
    return;
  }

  core.info(
    `Found existing SAM CLI at ${installRoot}; uninstalling before reinstall to avoid downgrade rejection.`,
  );

  // Done via a script file rather than `-Command` to sidestep the fragile
  // multi-level quoting required when passing a PowerShell script through
  // exec args.
  const flavor = nightly ? "nightly" : "stable";
  const script = `$ErrorActionPreference = 'Stop'
$flavor = $args[0]
$paths = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$entries = Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object {
  $_.DisplayName -and $_.DisplayName -like 'AWS SAM Command Line Interface*'
}
# Stable and nightly co-exist as separate products; keep them isolated.
if ($flavor -eq 'nightly') {
  $entries = $entries | Where-Object { $_.DisplayName -match '(?i)nightly' }
} else {
  $entries = $entries | Where-Object { $_.DisplayName -notmatch '(?i)nightly' }
}
$found = $false
foreach ($entry in $entries) {
  $found = $true
  $code = $entry.PSChildName
  if ($code -notmatch '^\\{[0-9A-Fa-f-]+\\}$') { continue }
  Write-Host "Uninstalling $($entry.DisplayName) ($code)"
  $p = Start-Process -FilePath msiexec.exe -ArgumentList '/x', $code, '/qn', '/norestart' -Wait -PassThru
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
    throw "msiexec /x $code failed with exit code $($p.ExitCode)"
  }
}
if (-not $found) {
  Write-Host "No matching $flavor SAM CLI uninstall registry entry found."
}
`;
  const scriptPath = path.join(mkdirTemp(), "uninstall-sam.ps1");
  fs.writeFileSync(scriptPath, script);

  const exitCode = await exec.exec(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      flavor,
    ],
    { ignoreReturnCode: true },
  );
  if (exitCode !== 0) {
    core.warning(
      `Pre-install uninstall step exited with code ${exitCode}; continuing.`,
    );
  }
}

/**
 * Installs SAM CLI on Windows by downloading and running the MSI.
 *
 * @param {string} inputVersion - The SAM CLI version to install or "nightly".
 * @returns {Promise<string>} The directory containing sam.cmd / sam.exe.
 */
async function installWindowsNativeInstaller(inputVersion) {
  // Validate version format (only x.y.z, "nightly", or empty are accepted)
  if (inputVersion && !isNightly(inputVersion) && !isSemver(inputVersion)) {
    core.setFailed('Version must be in the format x.y.z or "nightly"');
    return "";
  }

  const nightly = isNightly(inputVersion);
  const url = nightly
    ? windowsMsiUrl(NIGHTLY_TAG, true)
    : windowsMsiUrl(inputVersion, false);

  if (nightly) {
    core.info("Installing SAM CLI nightly release on Windows.");
  } else {
    core.info(
      `Installing SAM CLI ${inputVersion || "latest"} on Windows via MSI.`,
    );
  }

  try {
    // Remove any preinstalled SAM CLI of the same flavor first so msiexec
    // doesn't reject a downgrade or equal-version install.
    await uninstallExistingWindowsSamCli(nightly);

    // Windows Installer dispatches by file extension, so the destination
    // path must end in `.msi` — tc.downloadTool's default UUID filename
    // makes msiexec fail with exit code 1603.
    const msiDest = path.join(mkdirTemp(), "AWS_SAM_CLI_64_PY3.msi");
    const msiPath = await tc.downloadTool(url, msiDest);
    await runMsiExec(msiPath);
  } catch (error) {
    core.setFailed(`Failed to install SAM CLI MSI: ${error.message}`);
    return "";
  }

  let binDir;
  try {
    binDir = findWindowsSamBinDir(nightly);
  } catch (error) {
    core.setFailed(error.message);
    return "";
  }

  // Nightly MSI ships sam-nightly.{cmd,exe}; copy to sam.{cmd,exe} so users
  // can invoke `sam` regardless of which release they install.
  if (nightly) {
    for (const ext of ["cmd", "exe"]) {
      const src = path.join(binDir, `sam-nightly.${ext}`);
      const dst = path.join(binDir, `sam.${ext}`);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
      }
    }
  }

  return binDir;
}

/**
 * Installs SAM CLI on Linux using the official native installer archive.
 *
 * @param {string} inputVersion - The SAM CLI version to install or "nightly".
 * @param {string} token - Authentication Token to use for GITHUB Apis.
 * @returns {Promise<string>} The directory SAM CLI is installed in.
 */
async function installLinuxNativeInstaller(inputVersion, token) {
  if (os.arch() !== "x64" && os.arch() !== "arm64") {
    core.setFailed(
      "Only x86-64 and aarch64 architectures are supported with use-installer: true on Linux",
    );
    return "";
  }

  const arch = os.arch() === "arm64" ? "arm64" : "x86_64";

  // Nightly: download without caching since the "sam-cli-nightly" tag's
  // contents change daily, so a cache hit would serve stale binaries.
  if (isNightly(inputVersion)) {
    core.info("Installing SAM CLI nightly release without caching.");
    const binDir = await downloadWithoutCache(arch, NIGHTLY_TAG);
    if (binDir) {
      // The nightly archive ships `sam-nightly` instead of `sam`. Symlink so
      // `sam` works on PATH without users having to change their commands.
      const target = path.join(binDir, "sam-nightly");
      const link = path.join(binDir, "sam");
      if (fs.existsSync(target) && !fs.existsSync(link)) {
        fs.symlinkSync(target, link);
      }
    }
    return binDir;
  }

  // Validate version format
  if (inputVersion && !isSemver(inputVersion)) {
    core.setFailed('Version must be in the format x.y.z or "nightly"');
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

  // Try cache if we have a version
  if (version) {
    // Include ImageOS in cache key to isolate caches between runner images
    const imageOS = process.env.ImageOS || "unknown";
    const cacheKey = `sam-cli-${os.platform()}-${imageOS}-${arch}-${version}`;
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

/**
 * Installs SAM CLI using the native installers.
 *
 * See https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html
 *
 * @param {string} inputVersion - The SAM CLI version to install.
 * @param {string} token - Authentication Token to use for GITHUB Apis.
 * @returns {Promise<string>} The directory SAM CLI is installed in.
 */
// TODO: Support more platforms (macOS .pkg)
async function installUsingNativeInstaller(inputVersion, token) {
  if (os.platform() === "linux") {
    return await installLinuxNativeInstaller(inputVersion, token);
  }
  if (os.platform() === "win32") {
    return await installWindowsNativeInstaller(inputVersion);
  }
  core.setFailed(
    "use-installer: true is only supported on Linux and Windows runners",
  );
  return "";
}

async function setup() {
  const version = getInput("version", /^([\d.*]*|nightly)$/, "");
  // python3 isn't standard on Windows
  const defaultPython = isWindows() ? "python" : "python3";
  const python = getInput("python", /^.+$/, defaultPython);
  const useInstaller = core.getBooleanInput("use-installer");
  const token = getInput("token", /^.*$/, "");

  if (isNightly(version) && !useInstaller) {
    core.setFailed(
      'Installing the nightly release requires "use-installer: true". The aws-sam-cli nightly release is not published to PyPI.',
    );
    return;
  }

  const binPath = useInstaller
    ? await installUsingNativeInstaller(version, token)
    : await installSamCli(python, version);

  if (binPath) {
    core.addPath(binPath);
  }
}

module.exports = setup;
