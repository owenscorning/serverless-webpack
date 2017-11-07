'use strict';

const BbPromise = require('bluebird');
const path = require('path');

module.exports = {
  prepareRun() {
    this.originalServicePath = this.serverless.config.servicePath;
    this.serverless.config.servicePath = path.join(this.webpackOutputPath, 'service');

    // Set service path as CWD to allow accessing bundled files correctly
    process.chdir(this.serverless.config.servicePath);

    return BbPromise.resolve();
  }
};
