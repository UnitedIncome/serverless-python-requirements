/* jshint ignore:start */
'use strict';

const BbPromise = require('bluebird');
const _ = require('lodash');
const path = require('path');
const fse = require('fs-extra');
const child_process = require('child_process');
const Zip = require('adm-zip');

BbPromise.promisifyAll(fse);

class ServerlessPythonRequirements {
  packVendorHelper() {
    this.serverless.cli.log('Packaging Python requirements helper...');

    return fse.copyAsync(
      path.resolve(__dirname, 'sitecustomize.py'),
      path.join(this.serverless.config.servicePath, 'sitecustomize.py'));
  };

  installRequirements() {
    if (!fse.existsSync(path.join(this.serverless.config.servicePath, 'requirements.txt'))) {
      return BbPromise.resolve();
    }

    this.serverless.cli.log('Packaging required Python packages...');

    return new BbPromise((resolve, reject) => {
      let cmd = 'pip';
      let options = [
        '--isolated', 'install',
        '-t', '.requirements',
        '-r', 'requirements.txt',
      ];
      if (this.custom.dockerizePip) {
        cmd = 'docker';
        options = [
          'run', '--rm',
          '-v', `${this.serverless.config.servicePath}:/var/task:z`,
          'lambci/lambda:build-python2.7', 'pip',
        ].concat(options);
      }
      const res = child_process.spawnSync(cmd, options);
      if (res.error) {
        return reject(res.error);
      }
      if (res.status != 0) {
        return reject(res.stderr);
      }
      resolve();
    });
  };

  packRequirements() {
    return this.installRequirements().then(() => {
      return new BbPromise((resolve, reject) => {
        if (this.custom.zipImport) {
          const zip = new Zip();
          zip.addLocalFolder('.requirements', '');
          zip.writeZip('.requirements.zip');
          fse.remove('.requirements', (err) => err?reject():resolve());
        } else resolve();
      });
    });
  }

  cleanup() {
    const artifacts = ['sitecustomize.py'];
    if (this.custom.zipImport)
      artifacts.push('.requirements.zip')
    else
      artifacts.push('.requirements')

    return BbPromise.all(_.map(artifacts, (artifact) =>
      fse.removeAsync(path.join(this.serverless.config.servicePath, artifact))));;
  };

  serve() {
    const port = this.options.port || 5000;

    return new BbPromise((resolve, reject) => {
      child_process.spawnSync('python', [
        path.resolve(__dirname, 'serve.py'),
        this.serverless.config.servicePath,
        this.wsgiApp,
        port
      ], { stdio: 'inherit' });
      resolve();
    });
  };

  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.custom = this.serverless.service.custom && this.serverless.service.custom.pythonRequirements || {};

    this.commands = {
      'requirements': {
        commands: {
          'clean': {
            usage: 'Remove .requirements, .requirements.zip and sitecustomize.py',
            lifecycleEvents: [
              'clean',
            ],
          },
          'install': {
            usage: 'install requirements manually',
            lifecycleEvents: [
              'install',
            ],
          },
        },
      },
    };

    this.hooks = {
      'before:deploy:createDeploymentArtifacts': () => BbPromise.bind(this)
        .then(this.packVendorHelper)
        .then(this.packRequirements),

      'requirements:install:install': () => BbPromise.bind(this)
        .then(this.packVendorHelper)
        .then(this.packRequirements),

      'requirements:clean:clean': () => BbPromise.bind(this)
        .then(this.cleanup)
    };
  }
}

module.exports = ServerlessPythonRequirements;
