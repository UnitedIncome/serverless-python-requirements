const fse = require('fs-extra');
const rimraf = require('rimraf');
const path = require('path');
const get = require('lodash.get');
const set = require('lodash.set');
const { spawnSync } = require('child_process');
const { quote } = require('shell-quote');
const { buildImage, getBindPath, getDockerUid } = require('./docker');
const { getStripCommand, deleteFiles } = require('./slim');
const {
  checkForAndDeleteMaxCacheVersions,
  md5Path,
  getRequirementsWorkingPath,
  getUserCachePath
} = require('./shared');

function quote_single(quoteme) {
  return quote([quoteme]);
}

/**
 * Just generate the requirements file in the .serverless folder
 * @param {string} requirementsPath
 * @param {string} targetFile
 * @param {Object} serverless
 * @param {string} servicePath
 * @param {Object} options
 * @return {undefined}
 */
function installRequirementsFile(
  requirementsPath,
  targetFile,
  serverless,
  servicePath,
  options
) {
  if (options.usePipenv && fse.existsSync(path.join(servicePath, 'Pipfile'))) {
    generateRequirementsFile(
      path.join(servicePath, '.serverless/requirements.txt'),
      targetFile,
      options
    );
    serverless.cli.log(
      `Parsed requirements.txt from Pipfile in ${targetFile}...`
    );
  } else {
    generateRequirementsFile(requirementsPath, targetFile, options);
    serverless.cli.log(
      `Generated requirements from ${requirementsPath} in ${targetFile}...`
    );
  }
}

/**
 * Install requirements described from requirements in the targetFolder into that same targetFolder
 * @param {string} targetFolder
 * @param {Object} serverless
 * @param {Object} options
 * @return {undefined}
 */
function installRequirements(targetFolder, serverless, options) {
  const targetRequirementsTxt = path.join(targetFolder, 'requirements.txt');

  serverless.cli.log(
    `Installing requirements from ${targetRequirementsTxt} ...`
  );

  let cmd;
  let cmdOptions;
  let pipCmd = [
    options.pythonBin,
    '-m',
    'pip',
    'install',
    ...options.pipCmdExtraArgs
  ];
  // Check if we're using the legacy --cache-dir command...
  if (options.pipCmdExtraArgs.indexOf('--cache-dir') > -1) {
    if (options.dockerizePip) {
      throw 'Error: You can not use --cache-dir with Docker any more, please\n' +
        '         use the new option useDownloadCache instead.  Please see:\n' +
        '         https://github.com/UnitedIncome/serverless-python-requirements#caching';
    } else {
      serverless.cli.log('==================================================');
      serverless.cli.log(
        'Warning: You are using a deprecated --cache-dir inside\n' +
          '            your pipCmdExtraArgs which may not work properly, please use the\n' +
          '            useDownloadCache option instead.  Please see: \n' +
          '            https://github.com/UnitedIncome/serverless-python-requirements#caching'
      );
      serverless.cli.log('==================================================');
    }
  }

  if (!options.dockerizePip) {
    // Push our local OS-specific paths for requirements and target directory
    pipCmd.push('-t', dockerPathForWin(options, targetFolder));
    pipCmd.push('-r', dockerPathForWin(options, targetRequirementsTxt));
    // If we want a download cache...
    if (options.useDownloadCache) {
      const downloadCacheDir = path.join(
        getUserCachePath(options),
        'downloadCacheslspyc'
      );
      serverless.cli.log(`Using download cache directory ${downloadCacheDir}`);
      fse.ensureDirSync(downloadCacheDir);
      pipCmd.push('--cache-dir', quote_single(downloadCacheDir));
    }

    // Check if pip has Debian's --system option and set it if so
    const pipTestRes = spawnSync(options.pythonBin, [
      '-m',
      'pip',
      'help',
      'install'
    ]);
    if (pipTestRes.error) {
      if (pipTestRes.error.code === 'ENOENT') {
        throw new Error(
          `${options.pythonBin} not found! ` + 'Try the pythonBin option.'
        );
      }
      throw pipTestRes.error;
    }
    if (pipTestRes.stdout.toString().indexOf('--system') >= 0) {
      pipCmd.push('--system');
    }
  }
  // If we are dockerizing pip
  if (options.dockerizePip) {
    cmd = 'docker';

    // Push docker-specific paths for requirements and target directory
    pipCmd.push('-t', '/var/task/');
    pipCmd.push('-r', '/var/task/requirements.txt');

    // Build docker image if required
    let dockerImage;
    if (options.dockerFile) {
      serverless.cli.log(
        `Building custom docker image from ${options.dockerFile}...`
      );
      dockerImage = buildImage(options.dockerFile);
    } else {
      dockerImage = options.dockerImage;
    }
    serverless.cli.log(`Docker Image: ${dockerImage}`);

    var bindPath = ''; // Set this depending on whether remote host is being used.

    // If Docker is using a remote host, we can't mount local files. Need to use data volume instead, and copy files in.
    if (options.dockerRemoteHost) {
      // docker volume create data-volume
      serverless.cli.log('Remote docker option selected');
      serverless.cli.log('Creating data volume');
      cmdOptions = ['volume', 'create', 'data-volume']; // volume create data-volume
      executeCmdAsSpawnSync(cmd, cmdOptions, options);

      // docker create -v data-volume:/var/task --name helper (imagename) true
      serverless.cli.log('Mounting data volume to helper container');
      cmdOptions = [
        'create',
        '-v',
        'data-volume:/var/task',
        '--name',
        'helper',
        dockerImage,
        'true'
      ];
      executeCmdAsSpawnSync(cmd, cmdOptions, options);

      // copy the files onto the volume
      serverless.cli.log('Copying files onto volume');
      cmdOptions = [
        'cp',
        dockerPathForWin(options, targetFolder),
        'helper:/var/task'
      ]; // volume create data-volume
      executeCmdAsSpawnSync(cmd, cmdOptions, options);

      // remove the helper container - not needed any more
      serverless.cli.log('Removing helper image');
      cmdOptions = ['rm', 'helper']; // volume create data-volume
      executeCmdAsSpawnSync(cmd, cmdOptions, options);

      // Now set bindPath to the data volume (rather than a local folder)
      bindPath = 'data-volume';
      cmdOptions = [];
    } else {
      // Prepare bind path depending on os platform
      bindPath = dockerPathForWin(
        options,
        getBindPath(serverless, targetFolder)
      );
    }

    cmdOptions = [
      'run',
      '--name',
      'python-reqs',
      '-v',
      `${bindPath}:/var/task:z`
    ];

    if (options.proxy) {
      cmdOptions.push(
        '--env',
        `http_proxy=${options.proxy}`,
        '--env',
        `https_proxy=${options.proxy}`
      );
    }

    if (options.dockerSsh) {
      // Mount necessary ssh files to work with private repos
      cmdOptions.push(
        '-v',
        quote_single(`${process.env.HOME}/.ssh/id_rsa:/root/.ssh/id_rsa:z`)
      );
      cmdOptions.push(
        '-v',
        quote_single(
          `${process.env.HOME}/.ssh/known_hosts:/root/.ssh/known_hosts:z`
        )
      );
      cmdOptions.push(
        '-v',
        quote_single(`${process.env.SSH_AUTH_SOCK}:/tmp/ssh_sock:z`)
      );
      cmdOptions.push('-e', 'SSH_AUTH_SOCK=/tmp/ssh_sock');
    }

    // If we want a download cache...
    const dockerDownloadCacheDir = '/var/useDownloadCache';
    if (options.useDownloadCache) {
      const downloadCacheDir = path.join(
        getUserCachePath(options),
        'downloadCacheslspyc'
      );
      serverless.cli.log(`Using download cache directory ${downloadCacheDir}`);
      fse.ensureDirSync(downloadCacheDir);
      // This little hack is necessary because getBindPath requires something inside of it to test...
      // Ugh, this is so ugly, but someone has to fix getBindPath in some other way (eg: make it use
      // its own temp file)
      fse.closeSync(
        fse.openSync(path.join(downloadCacheDir, 'requirements.txt'), 'w')
      );
      const windowsized = getBindPath(serverless, downloadCacheDir);
      // And now push it to a volume mount and to pip...
      cmdOptions.push(
        '-v',
        quote_single(`${windowsized}:${dockerDownloadCacheDir}:z`)
      );
      pipCmd.push('--cache-dir', quote_single(dockerDownloadCacheDir));
    }

    if (process.platform === 'linux') {
      // Use same user so requirements folder is not root and so --cache-dir works
      var commands = [];
      if (options.useDownloadCache) {
        // Set the ownership of the download cache dir to root
        commands.push(quote(['chown', '-R', '0:0', dockerDownloadCacheDir]));
      }
      // Install requirements with pip
      commands.push(pipCmd.join(' '));
      // Set the ownership of the current folder to user
      commands.push(
        quote([
          'chown',
          '-R',
          `${process.getuid()}:${process.getgid()}`,
          '/var/task'
        ])
      );
      if (options.useDownloadCache) {
        // Set the ownership of the download cache dir back to user
        commands.push(
          quote([
            'chown',
            '-R',
            `${process.getuid()}:${process.getgid()}`,
            dockerDownloadCacheDir
          ])
        );
      }
      pipCmd = ['/bin/bash', '-c', '"' + commands.join(' && ') + '"'];
    } else {
      // Use same user so --cache-dir works
      cmdOptions.push('-u', quote_single(getDockerUid(bindPath)));
    }
    cmdOptions.push(dockerImage);
    cmdOptions.push(...pipCmd);
  } else {
    cmd = pipCmd[0];
    cmdOptions = pipCmd.slice(1);
  }

  // If enabled slimming, strip so files
  if (options.slim === true || options.slim === 'true') {
    const preparedPath = dockerPathForWin(options, targetFolder);
    cmdOptions.push(getStripCommand(options, preparedPath));
  }

  try {
    // execute the pip install (inside the container
    executeCmdAsSpawnSync(cmd, cmdOptions, options);

    if (options.dockerizePip) {
      if (options.dockerRemoteHost) {
        // copy the files back from the data volume
        serverless.cli.log(
          'Copying python libraries off docker container, ready for zipping'
        );
        cmdOptions = ['cp', 'python-reqs:/var/task/.', targetFolder]; // volume create data-volume
        executeCmdAsSpawnSync(cmd, cmdOptions, options);
      }
    }
  } finally {
    if (options.dockerizePip) {
      // clean up for next time.
      serverless.cli.log('Removing container image');
      cmdOptions = ['rm', 'python-reqs']; // remove data-volume
      executeCmdAsSpawnSync(cmd, cmdOptions, options);
    }
  }

  // If enabled slimming, delete files in slimPatterns
  if (options.slim === true || options.slim === 'true') {
    deleteFiles(options, targetFolder);
  }
}

function executeCmdAsSpawnSync(cmd, cmdOptions, options) {
  let spawnArgs = { shell: true };
  if (process.env.SLS_DEBUG) {
    spawnArgs.stdio = 'inherit';
  }
  const res = spawnSync(cmd, cmdOptions, spawnArgs);
  if (res.error) {
    if (res.error.code === 'ENOENT') {
      if (options.dockerizePip) {
        throw new Error('docker not found! Please install it.');
      }
      throw new Error(
        `${options.pythonBin} not found! Try the pythonBin option.`
      );
    }
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error(res.stderr);
  }
}

/**
 * convert path from Windows style to Linux style, if needed
 * @param {Object} options
 * @param {string} path
 * @return {string}
 */
function dockerPathForWin(options, path) {
  if (process.platform === 'win32' && options.dockerizePip) {
    return path.replace(/\\/g, '/');
  }
  return quote_single(path);
}

/** create a filtered requirements.txt without anything from noDeploy
 *  then remove all comments and empty lines, and sort the list which
 *  assist with matching the static cache.  The sorting will skip any
 *  lines starting with -- as those are typically ordered at the
 *  start of a file ( eg: --index-url / --extra-index-url ) or any
 *  lines that start with -f or -i,  Please see:
 * https://pip.pypa.io/en/stable/reference/pip_install/#requirements-file-format
 * @param {string} source requirements
 * @param {string} target requirements where results are written
 * @param {Object} options
 */
function generateRequirementsFile(source, target, options) {
  const noDeploy = new Set(options.noDeploy || []);
  const requirements = fse
    .readFileSync(source, { encoding: 'utf-8' })
    .replace(/\\\n/g, ' ')
    .split(/\r?\n/);
  var prepend = [];
  const filteredRequirements = requirements.filter(req => {
    req = req.trim();
    if (req.startsWith('#')) {
      // Skip comments
      return false;
    } else if (
      req.startsWith('--') ||
      req.startsWith('-f') ||
      req.startsWith('-i')
    ) {
      // If we have options (prefixed with --) keep them for later
      prepend.push(req);
      return false;
    } else if (req === '') {
      return false;
    }
    return !noDeploy.has(req.split(/[=<> \t]/)[0].trim());
  });
  filteredRequirements.sort(); // Sort remaining alphabetically
  // Then prepend any options from above in the same order
  for (let item of prepend.reverse()) {
    if (item && item.length > 0) {
      filteredRequirements.unshift(item);
    }
  }
  fse.writeFileSync(target, filteredRequirements.join('\n') + '\n');
}

/**
 * Copy everything from vendorFolder to targetFolder
 * @param {string} vendorFolder
 * @param {string} targetFolder
 * @param {Object} serverless
 * @return {undefined}
 */
function copyVendors(vendorFolder, targetFolder, serverless) {
  // Create target folder if it does not exist
  fse.ensureDirSync(targetFolder);

  serverless.cli.log(
    `Copying vendor libraries from ${vendorFolder} to ${targetFolder}...`
  );

  fse.readdirSync(vendorFolder).map(file => {
    let source = path.join(vendorFolder, file);
    let dest = path.join(targetFolder, file);
    if (fse.existsSync(dest)) {
      rimraf.sync(dest);
    }
    fse.copySync(source, dest);
  });
}

/**
 * This evaluates if requirements are actually needed to be installed, but fails
 * gracefully if no req file is found intentionally.  It also assists with code
 * re-use for this logic pertaining to individually packaged functions
 * @param {string} servicePath
 * @param {string} modulePath
 * @param {Object} options
 * @param {Object} funcOptions
 * @param {Object} serverless
 * @return {string}
 */
function installRequirementsIfNeeded(
  servicePath,
  modulePath,
  options,
  funcOptions,
  serverless
) {
  // Our source requirements, under our service path, and our module path (if specified)
  const fileName = path.join(servicePath, modulePath, options.fileName);

  // First, generate the requirements file to our local .serverless folder
  fse.ensureDirSync(path.join(servicePath, '.serverless'));
  const slsReqsTxt = path.join(servicePath, '.serverless', 'requirements.txt');

  installRequirementsFile(
    fileName,
    slsReqsTxt,
    serverless,
    servicePath,
    options
  );

  // If no requirements file or an empty requirements file, then do nothing
  if (!fse.existsSync(slsReqsTxt) || fse.statSync(slsReqsTxt).size == 0) {
    serverless.cli.log(
      `Skipping empty output requirements.txt file from ${slsReqsTxt}`
    );
    return false;
  }

  // Copy our requirements to another filename in .serverless (incase of individually packaged)
  if (modulePath && modulePath != '.') {
    fse.existsSync(path.join(servicePath, '.serverless', modulePath));
    const destinationFile = path.join(
      servicePath,
      '.serverless',
      modulePath,
      'requirements.txt'
    );
    serverless.cli.log(
      `Copying from ${slsReqsTxt} into ${destinationFile} ...`
    );
    fse.copySync(slsReqsTxt, destinationFile);
  }

  // Then generate our MD5 Sum of this requirements file to determine where it should "go" to and/or pull cache from
  const reqChecksum = md5Path(slsReqsTxt);

  // Then figure out where this cache should be, if we're caching, if we're in a module, etc
  const workingReqsFolder = getRequirementsWorkingPath(
    reqChecksum,
    servicePath,
    options
  );

  // Check if our static cache is present and is valid
  if (fse.existsSync(workingReqsFolder)) {
    if (
      fse.existsSync(path.join(workingReqsFolder, '.completed_requirements')) &&
      workingReqsFolder.endsWith('_slspyc')
    ) {
      serverless.cli.log(
        `Using static cache of requirements found at ${workingReqsFolder} ...`
      );
      // We'll "touch" the folder, as to bring it to the start of the FIFO cache
      fse.utimesSync(workingReqsFolder, new Date(), new Date());
      return workingReqsFolder;
    }
    // Remove our old folder if it didn't complete properly, but _just incase_ only remove it if named properly...
    if (
      workingReqsFolder.endsWith('_slspyc') ||
      workingReqsFolder.endsWith('.requirements')
    ) {
      rimraf.sync(workingReqsFolder);
    }
  }

  // Ensuring the working reqs folder exists
  fse.ensureDirSync(workingReqsFolder);

  // Copy our requirements.txt into our working folder...
  fse.copySync(slsReqsTxt, path.join(workingReqsFolder, 'requirements.txt'));

  // Then install our requirements from this folder
  installRequirements(workingReqsFolder, serverless, options);

  // Copy vendor libraries to requirements folder
  if (options.vendor) {
    copyVendors(options.vendor, workingReqsFolder, serverless);
  }
  if (funcOptions.vendor) {
    copyVendors(funcOptions.vendor, workingReqsFolder, serverless);
  }

  // Then touch our ".completed_requirements" file so we know we can use this for static cache
  if (options.useStaticCache) {
    fse.closeSync(
      fse.openSync(path.join(workingReqsFolder, '.completed_requirements'), 'w')
    );
  }
  return workingReqsFolder;
}

/**
 * pip install the requirements to the requirements directory
 * @return {undefined}
 */
function installAllRequirements() {
  // fse.ensureDirSync(path.join(this.servicePath, '.serverless'));
  // First, check and delete cache versions, if enabled
  checkForAndDeleteMaxCacheVersions(this.options, this.serverless);

  // Then if we're going to package functions individually...
  if (this.serverless.service.package.individually) {
    let doneModules = [];
    this.targetFuncs
      .filter(func =>
        (func.runtime || this.serverless.service.provider.runtime).match(
          /^python.*/
        )
      )
      .map(f => {
        if (!get(f, 'module')) {
          set(f, ['module'], '.');
        }
        // If we didn't already process a module (functions can re-use modules)
        if (!doneModules.includes(f.module)) {
          const reqsInstalledAt = installRequirementsIfNeeded(
            this.servicePath,
            f.module,
            this.options,
            f,
            this.serverless
          );
          // Add modulePath into .serverless for each module so it's easier for injecting and for users to see where reqs are
          let modulePath = path.join(
            this.servicePath,
            '.serverless',
            `${f.module}`,
            'requirements'
          );
          // Only do if we didn't already do it
          if (
            reqsInstalledAt &&
            !fse.existsSync(modulePath) &&
            reqsInstalledAt != modulePath
          ) {
            if (this.options.useStaticCache) {
              // Windows can't symlink so we have to copy on Windows,
              // it's not as fast, but at least it works
              if (process.platform == 'win32') {
                fse.copySync(reqsInstalledAt, modulePath);
              } else {
                fse.symlink(reqsInstalledAt, modulePath);
              }
            } else {
              fse.rename(reqsInstalledAt, modulePath);
            }
          }
          doneModules.push(f.module);
        }
      });
  } else {
    const reqsInstalledAt = installRequirementsIfNeeded(
      this.servicePath,
      '',
      this.options,
      {},
      this.serverless
    );
    // Add symlinks into .serverless for so it's easier for injecting and for users to see where reqs are
    let symlinkPath = path.join(
      this.servicePath,
      '.serverless',
      `requirements`
    );
    // Only do if we didn't already do it
    if (
      reqsInstalledAt &&
      !fse.existsSync(symlinkPath) &&
      reqsInstalledAt != symlinkPath
    ) {
      // Windows can't symlink so we have to copy on Windows,
      // it's not as fast, but at least it works
      if (process.platform == 'win32') {
        fse.copySync(reqsInstalledAt, symlinkPath);
      } else {
        fse.symlink(reqsInstalledAt, symlinkPath);
      }
    }
  }
}

module.exports = { installAllRequirements };
