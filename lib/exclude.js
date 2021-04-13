const path = require('path');
const glob = require('glob-all');
const fse = require('fs-extra');

/**
 * remove all excluded patterns
 * @return {undefined}
 */
function removeExcluded() {
  if (
    Array.isArray(this.options.excluded) &&
    this.options.excluded.length > 0
  ) {
    const DEBUG = process.env.SLS_DEBUG;

    const basePath = path.join(this.servicePath, '.serverless', `requirements`);
    if (DEBUG) this.serverless.cli.log(`Performing removal of excluded files`);
    for (const pattern of this.options.excluded) {
      if (DEBUG) this.serverless.cli.log(`Pattern: ${basePath}/${pattern}`);
      for (const file of glob.sync(`${basePath}/${pattern}`)) {
        if (DEBUG) this.serverless.cli.log(`Found, removing: ${file}`);
        fse.removeSync(file);
      }
    }
  }
}

module.exports = { removeExcluded };
