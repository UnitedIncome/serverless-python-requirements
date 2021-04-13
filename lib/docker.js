const { spawnSync } = require('child_process');
const isWsl = require('is-wsl');
const fse = require('fs-extra');
const path = require('path');
let cachedContainerId = false;

/**
 * A helper function to determine if we are inside Docker
 * @return {boolean} if we are inside docker or not
 */
function areInsideDocker() {
  return fse.existsSync('/.dockerenv')
}

/**
 * A helper function to determine the container id when inside docker, caching results
 * @return {string} sha container id, or returns false on error/failure
 */
function getContainerIdFromWithinContainer() {
  if (cachedContainerId){ return cachedContainerId; }
  try {
    // First, detect our container id by using /proc/self/cgroup trick
    cgroup = fse.readFileSync('/proc/self/cgroup', { encoding: 'utf-8' });
    // Parse the stdout and extract the systemd line, and the the last tokenized item in that line
    pos1 = cgroup.toString('utf8').indexOf("systemd");
    cachedContainerId = cgroup.toString('utf8').substr(pos1, cgroup.toString('utf8').indexOf("\n", pos1)-pos1).split('/').pop();
    return cachedContainerId
  } catch (e) {
    console.error("Docker-in-Docker: Unable to get container id from within container, cgroup might not be present");
    console.error(e);
    return false;
  }
}

/**
 * Helper function to run a docker command
 * @param {string[]} options
 * @return {Object}
 */
function dockerCommand(options) {
  const cmd = 'docker';
  const ps = spawnSync(cmd, options, { encoding: 'utf-8' });
  if (ps.error) {
    if (ps.error.code === 'ENOENT') {
      throw new Error('docker not found! Please install it.');
    }
    throw new Error(ps.error);
  } else if (ps.status !== 0) {
    throw new Error(ps.stderr);
  }
  return ps;
}

/**
 * Build the custom Docker image
 * @param {string} dockerFile
 * @param {string[]} extraArgs
 * @return {string} The name of the built docker image.
 */
function buildImage(dockerFile, extraArgs) {
  const imageName = 'sls-py-reqs-custom';
  const options = ['build', '-f', dockerFile, '-t', imageName];

  if (Array.isArray(extraArgs)) {
    options.push(...extraArgs);
  } else {
    throw new Error('dockerRunCmdExtraArgs option must be an array');
  }

  options.push('.');

  dockerCommand(options);
  return imageName;
}

/**
 * Find a file that exists on all projects so we can test if Docker can see it too
 * @param {string} servicePath
 * @return {string} file name
 */
function findTestFile(servicePath) {
  if (fse.pathExistsSync(path.join(servicePath, 'serverless.yml'))) {
    return 'serverless.yml';
  }
  if (fse.pathExistsSync(path.join(servicePath, 'serverless.yaml'))) {
    return 'serverless.yaml';
  }
  if (fse.pathExistsSync(path.join(servicePath, 'serverless.json'))) {
    return 'serverless.json';
  }
  if (fse.pathExistsSync(path.join(servicePath, 'requirements.txt'))) {
    return 'requirements.txt';
  }
  throw new Error(
    'Unable to find serverless.{yml|yaml|json} or requirements.txt for getBindPath()'
  );
}

/**
 * Test bind path to make sure it's working
 * @param {string} bindPath
 * @return {boolean}
 */
function tryBindPath(serverless, bindPath, testFile) {
  const debug = process.env.SLS_DEBUG;
  const options = [
    'run',
    '--rm',
    '-v',
    `${bindPath}:/test`,
    'alpine',
    'ls',
    `/test/${testFile}`,
  ];
  try {
    if (debug) serverless.cli.log(`Trying bindPath ${bindPath} (${options})`);
    const ps = dockerCommand(options);
    if (debug) serverless.cli.log(ps.stdout.trim());
    return ps.stdout.trim() === `/test/${testFile}`;
  } catch (err) {
    if (debug) serverless.cli.log(`Finding bindPath failed with ${err}`);
    return false;
  }
}

/**
 * Get bind path depending on os platform
 * @param {object} serverless
 * @param {string} servicePath
 * @param {Object} options serverless cli options to alter logic
 * @return {string} The bind path.
 */
function getBindPath(serverless, servicePath, options) {
  serverless.cli.log(`Docker-In-Docker: servicePath: ${servicePath}`);
  // Determine bind path
  if (process.platform !== 'win32' && !isWsl) {
    // Detect if we're trying to do docker-in-docker
    if (options.dockerizePip && areInsideDocker()) {
      serverless.cli.log(`Docker-In-Docker: We have detected an docker-in-docker configuration.  NOTE: This feature is in beta for this plugin, verbose output for now`);
      // Check if we want to specify our own path...
      if (options.dockerInDockerPath) {
          serverless.cli.log(`Docker-In-Docker: User-specified docker-in-docker current working directory path on host: ${options.dockerInDockerPath}`);
          return options.dockerInDockerPath + "/.serverless"
      }
      // Get our container id from within docker-in-docker
      let containerId = getContainerIdFromWithinContainer();
      if (!containerId) {
          console.log(`Docker-In-Docker: Unable to get container ID, falling back to local path.  WARNING this will probably not work...`);
          return servicePath;
      }
      serverless.cli.log(`Docker-In-Docker: Detected container: ${containerId}`);
      // Inspect this container to get the root volume mount
      data = dockerCommand(['inspect', containerId]).output[1];
      result = JSON.parse(data)[0]['GraphDriver']['Data']['MergedDir'];
      serverless.cli.log(`Docker-In-Docker: Found docker-in-docker root volume mounted from: ` + JSON.stringify(result))
      serverless.cli.log(`Docker-In-Docker: Using: ` + result + servicePath);
      return result + servicePath
    } else {
      // Check if we're inside docker
      return servicePath;
    }
  }

  // test docker is available
  dockerCommand(['version']);

  // find good bind path for Windows
  let bindPaths = [];
  let baseBindPath = servicePath.replace(/\\([^\s])/g, '/$1');
  let drive;
  let path;

  bindPaths.push(baseBindPath);
  if (baseBindPath.startsWith('/mnt/')) {
    // cygwin "/mnt/C/users/..."
    baseBindPath = baseBindPath.replace(/^\/mnt\//, '/');
  }
  if (baseBindPath[1] == ':') {
    // normal windows "c:/users/..."
    drive = baseBindPath[0];
    path = baseBindPath.substring(3);
  } else if (baseBindPath[0] == '/' && baseBindPath[2] == '/') {
    // gitbash "/c/users/..."
    drive = baseBindPath[1];
    path = baseBindPath.substring(3);
  } else {
    throw new Error(`Unknown path format ${baseBindPath.substr(10)}...`);
  }

  bindPaths.push(`/${drive.toLowerCase()}/${path}`); // Docker Toolbox (seems like Docker for Windows can support this too)
  bindPaths.push(`${drive.toLowerCase()}:/${path}`); // Docker for Windows
  // other options just in case
  bindPaths.push(`/${drive.toUpperCase()}/${path}`);
  bindPaths.push(`/mnt/${drive.toLowerCase()}/${path}`);
  bindPaths.push(`/mnt/${drive.toUpperCase()}/${path}`);
  bindPaths.push(`${drive.toUpperCase()}:/${path}`);

  const testFile = findTestFile(servicePath);

  for (let i = 0; i < bindPaths.length; i++) {
    const bindPath = bindPaths[i];
    if (tryBindPath(serverless, bindPath, testFile)) {
      return bindPath;
    }
  }

  throw new Error('Unable to find good bind path format');
}

/**
 * Find out what uid the docker machine is using
 * @param {string} bindPath
 * @return {boolean}
 */
function getDockerUid(bindPath) {
  const options = [
    'run',
    '--rm',
    '-v',
    `${bindPath}:/test`,
    'alpine',
    'stat',
    '-c',
    '%u',
    '/bin/sh',
  ];
  const ps = dockerCommand(options);
  return ps.stdout.trim();
}

module.exports = { buildImage, getBindPath, getDockerUid, areInsideDocker };
