'use strict';

const BbPromise = require('bluebird');
const _ = require('lodash');
const path = require('path');
const childProcess = require('child_process');
const fse = require('fs-extra');
const isBuiltinModule = require('is-builtin-module');

/**
 * Add the given modules to a package json's dependencies.
 */
function addModulesToPackageJson(externalModules, packageJson) {
  _.forEach(externalModules, externalModule => {
    const splitModule = _.split(externalModule, '@');
    // If we have a scoped module we have to re-add the @
    if (_.startsWith(externalModule, '@')) {
      splitModule.splice(0, 1);
      splitModule[0] = '@' + splitModule[0];
    }
    const moduleVersion = _.join(_.tail(splitModule), '@');
    packageJson.dependencies = packageJson.dependencies || {};
    packageJson.dependencies[_.first(splitModule)] = moduleVersion;
  });
}

/**
 * Remove a given list of excluded modules from a module list
 * @this - The active plugin instance
 */
function removeExcludedModules(modules, packageForceExcludes, log) {
  const excludedModules = _.remove(modules, externalModule => {
    const splitModule = _.split(externalModule, '@');
    // If we have a scoped module we have to re-add the @
    if (_.startsWith(externalModule, '@')) {
      splitModule.splice(0, 1);
      splitModule[0] = '@' + splitModule[0];
    }
    const moduleName = _.first(splitModule);
    return _.includes(packageForceExcludes, moduleName);
  });

  if (log && !_.isEmpty(excludedModules)) {
    this.serverless.cli.log(`Excluding external modules: ${_.join(excludedModules, ', ')}`);
  }
}

/**
 * Resolve the needed versions of production depenencies for external modules.
 * @this - The active plugin instance
 */
function getProdModules(externalModules, packagePath, dependencyGraph) {
  const packageJsonPath = path.join(process.cwd(), packagePath);
  const packageJson = require(packageJsonPath);
  const prodModules = [];

  // only process the module stated in dependencies section
  if (!packageJson.dependencies) {
    return [];
  }

  // Get versions of all transient modules
  _.forEach(externalModules, module => {
    let moduleVersion = packageJson.dependencies[module.external];

    if (moduleVersion) {
      prodModules.push(`${module.external}@${moduleVersion}`);

      // Check if the module has any peer dependencies and include them too
      try {
        const modulePackagePath = path.join(
          path.dirname(path.join(process.cwd(), packagePath)),
          'node_modules',
          module.external,
          'package.json'
        );
        const peerDependencies = require(modulePackagePath).peerDependencies;
        if (!_.isEmpty(peerDependencies)) {
          this.options.verbose && this.serverless.cli.log(`Adding explicit peers for dependency ${module.external}`);
          const peerModules = getProdModules.call(this, _.map(peerDependencies, (value, key) => ({ external: key })), packagePath, dependencyGraph);
          Array.prototype.push.apply(prodModules, peerModules);
        }
      } catch (e) {
        this.serverless.cli.log(`WARNING: Could not check for peer dependencies of ${module.external}`);
      }
    } else if (!packageJson.devDependencies || !packageJson.devDependencies[module.external]) {
      // Add transient dependencies if they appear not in the service's dev dependencies
      const originInfo = _.get(dependencyGraph, 'dependencies', {})[module.origin] || {};
      moduleVersion = _.get(_.get(originInfo, 'dependencies', {})[module.external], 'version');
      if (!moduleVersion) {
        this.serverless.cli.log(`WARNING: Could not determine version of module ${module.external}`);
      }
      prodModules.push(moduleVersion ? `${module.external}@${moduleVersion}` : module.external);
    }
  });

  return prodModules;
}

function getExternalModuleName(module) {
  const path = /^external "(.*)"$/.exec(module.identifier())[1];
  const pathComponents = path.split('/');
  const main = pathComponents[0];

  // this is a package within a namespace
  if (main.charAt(0) == '@') {
    return `${main}/${pathComponents[1]}`;
  }

  return main;
}

function isExternalModule(module) {
  return _.startsWith(module.identifier(), 'external ') && !isBuiltinModule(getExternalModuleName(module));
}

/**
 * Find the original module that required the transient dependency. Returns
 * undefined if the module is a first level dependency.
 * @param {Object} issuer - Module issuer
 */
function findExternalOrigin(issuer) {
  if (!_.isNil(issuer) && _.startsWith(issuer.rawRequest, './')) {
    return findExternalOrigin(issuer.issuer);
  }
  return issuer;
}

function getExternalModules(stats) {
  const externals = new Set();

  _.forEach(stats.compilation.chunks, chunk => {
    // Explore each module within the chunk (built inputs):
    _.forEach(chunk.modules, module => {
      if (isExternalModule(module)) {
        externals.add({
          origin: _.get(findExternalOrigin(module.issuer), 'rawRequest'),
          external: getExternalModuleName(module)
        });
      }
    });
  });

  return Array.from(externals);
}

module.exports = {
  /**
   * We need a performant algorithm to install the packages for each single
   * function (in case we package individually).
   * (1) We fetch ALL packages needed by ALL functions in a first step
   * and use this as a base npm checkout. The checkout will be done to a
   * separate temporary directory with a package.json that contains everything.
   * (2) For each single compile we copy the whole node_modules to the compile
   * directory and create a (function) compile specific package.json and store
   * it in the compile directory. Now we start npm again there, and npm will just
   * remove the superfluous packages and optimize the remaining dependencies.
   * This will utilize the npm cache at its best and give us the needed results
   * and performance.
   */
  packExternalModules() {

    const stats = this.compileStats;

    const includes = (
      this.serverless.service.custom &&
      this.serverless.service.custom.webpackIncludeModules
    );

    if (!includes) {
      return BbPromise.resolve();
    }

    // Read plugin configuration
    const packageForceIncludes = _.get(includes, 'forceInclude', []);
    const packageForceExcludes = _.get(includes, 'forceExclude', []);
    const packagePath = includes.packagePath || './package.json';
    const packageJsonPath = path.join(process.cwd(), packagePath);

    this.options.verbose && this.serverless.cli.log(`Fetch dependency graph from ${packageJsonPath}`);
    // Get first level dependency graph
    const command = 'npm ls -prod -json -depth=1';  // Only prod dependencies

    const ignoredNpmErrors = [
      { npmError: 'extraneous', log: false },
      { npmError: 'missing', log: false },
      { npmError: 'peer dep missing', log: true },
    ];

    return BbPromise.fromCallback(cb => {
      childProcess.exec(command, {
        cwd: path.dirname(packageJsonPath),
        maxBuffer: this.serverless.service.custom.packExternalModulesMaxBuffer || 200 * 1024,
        encoding: 'utf8'
      }, (err, stdout, stderr) => {
        if (err) {
          // Only exit with an error if we have critical npm errors for 2nd level inside
          const errors = _.split(stderr, '\n');
          const failed = _.reduce(errors, (failed, error) => {
            if (failed) {
              return true;
            }
            return !_.isEmpty(error) && !_.some(ignoredNpmErrors, ignoredError => _.startsWith(error, `npm ERR! ${ignoredError.npmError}`));
          }, false);

          if (failed) {
            return cb(err);
          }
        }
        return cb(null, stdout);
      });
    })
    .then(depJson => BbPromise.try(() => JSON.parse(depJson)))
    .then(dependencyGraph => {
      const problems = _.get(dependencyGraph, 'problems', []);
      if (this.options.verbose && !_.isEmpty(problems)) {
        this.serverless.cli.log(`Ignoring ${_.size(problems)} NPM errors:`);
        _.forEach(problems, problem => {
          this.serverless.cli.log(`=> ${problem}`);
        });
      }

      // (1) Generate dependency composition
      const compositeModules = _.uniq(_.flatMap(stats.stats, compileStats => {
        const externalModules = _.concat(
          getExternalModules.call(this, compileStats),
          _.map(packageForceIncludes, whitelistedPackage => ({ external: whitelistedPackage }))
        );
        return getProdModules.call(this, externalModules, packagePath, dependencyGraph);
      }));
      removeExcludedModules.call(this, compositeModules, packageForceExcludes, true);

      if (_.isEmpty(compositeModules)) {
        // The compiled code does not reference any external modules at all
        this.serverless.cli.log('No external modules needed');
        return BbPromise.resolve();
      }

      // (1.a) Install all needed modules
      const compositeModulePath = path.join(this.webpackOutputPath, 'dependencies');
      const compositePackageJson = path.join(compositeModulePath, 'package.json');

      // (1.a.1) Create a package.json
      const compositePackage = {
        name: this.serverless.service.service,
        version: '1.0.0',
        description: `Packaged externals for ${this.serverless.service.service}`,
        private: true
      };
      addModulesToPackageJson(compositeModules, compositePackage);
      this.serverless.utils.writeFileSync(compositePackageJson, JSON.stringify(compositePackage, null, 2));

      // (?.?.?) Look for linked packages
      return BbPromise.fromCallback(cb => {
          childProcess.exec(`npm ls --link --depth=0 --prod --json`, {
            cwd: path.dirname(packageJsonPath),
            maxBuffer: this.serverless.service.custom.packExternalModulesMaxBuffer || 200 * 1024,
            encoding: 'utf8'
          }, cb)
      })
      .then(depJson => BbPromise.try(() => JSON.parse(depJson)))
      .then(linkedDepJson => {
        // (?.?.?) Bump that up to the compositeModules to see which linked modules need included
        const linkedDependencies = linkedDepJson.dependencies;
        if (_.isEmpty(compositeModules)) {
          return BbPromise.resolve([]);
        } else {
          const includedLinkedModules = _.intersection(compositeModules.map(m => m.split('@')[0]), Object.keys(linkedDepJson.dependencies));
          return BbPromise.resolve(includedLinkedModules);
        }
      })
      .then(modulesToNpmLink => {
        if (_.isEmpty(modulesToNpmLink)) {
          return BbPromise.resolve([]);
        } else {
          // (?.?.?) Find targets of the npm link
          // TODO this is not platform-independent.  Supposedly npm link creates a global link for all these, and `npm ls --link --depth=0 --global` will list the targets,
          // but on our test lerna project not all the npm links generated by lerna seem to be doing that.  Look at it later since we have to keep moving.
          return BbPromise.fromCallback(cb => {
            childProcess.exec(`ls -l | grep lrw | grep '${modulesToNpmLink.map(l => l.split('@')[0]).join('\|')}' | awk '{print $NF}' | xargs -n1 realpath`, {
              cwd: `${packageJsonPath.replace(/package.json$/, 'node_modules')}`,
              maxBuffer: this.serverless.service.custom.packExternalModulesMaxBuffer || 200 * 1024,
              encoding: 'utf8'
            }, cb)
          })
        }
      })
      .then(output => {
        return BbPromise.resolve(output.split("\n").filter(e => e));
      })
      .then(links => {
        const npmLinks = _.map(links, link => {
          this.serverless.cli.log(`npm link ${link}`);
          return BbPromise.fromCallback(cb => {
            childProcess.exec(`npm link ${link}`, {
              cwd: compositeModulePath,
              maxBuffer: this.serverless.service.custom.packExternalModulesMaxBuffer || 200 * 1024,
              encoding: 'utf8'
            }, cb)
          })
        });
        return BbPromise.all(npmLinks);
      })
      .then(() => {
        // (1.a.2) Copy package-lock.json if it exists, to prevent unwanted upgrades
        const packageLockPath = path.join(path.dirname(packageJsonPath), 'package-lock.json');
        return BbPromise.fromCallback(cb => fse.pathExists(packageLockPath, cb))
        .then(exists => {
          if (exists) {
            this.serverless.cli.log('Package lock found - Using locked versions');
            return BbPromise.fromCallback(cb => fse.copy(packageLockPath, path.join(compositeModulePath, 'package-lock.json'), cb))
            .catch(err => this.serverless.cli.log(`Warning: Could not copy lock file: ${err.message}`));
          }
          return BbPromise.resolve();
        })
        .then(() => {
          const start = _.now();
          this.serverless.cli.log('Packing external modules: ' + compositeModules.join(', '));
          return BbPromise.fromCallback(cb => {
            childProcess.exec('npm install', {
              cwd: compositeModulePath,
              maxBuffer: this.serverless.service.custom.packExternalModulesMaxBuffer || 200 * 1024,
              encoding: 'utf8'
            }, cb);
          })
          .then(() => this.options.verbose && this.serverless.cli.log(`Package took [${_.now() - start} ms]`))
          .return(stats.stats);
        })
        .mapSeries(compileStats => {
          const modulePath = compileStats.compilation.compiler.outputPath;

          // Create package.json
          const modulePackageJson = path.join(modulePath, 'package.json');
          const modulePackage = {
            dependencies: {}
          };
          const prodModules = getProdModules.call(this,
            _.concat(
              getExternalModules.call(this, compileStats),
              _.map(packageForceIncludes, whitelistedPackage => ({ external: whitelistedPackage }))
            ), packagePath, dependencyGraph);
          removeExcludedModules.call(this, prodModules, packageForceExcludes);
          addModulesToPackageJson(prodModules, modulePackage);
          this.serverless.utils.writeFileSync(modulePackageJson, JSON.stringify(modulePackage, null, 2));

          // GOOGLE: Copy modules only if not google-cloud-functions
          //         GCF Auto installs the package json
          if (_.get(this.serverless, 'service.provider.name') === 'google') {
            return BbPromise.resolve();
          }

          const startCopy = _.now();
          return BbPromise.fromCallback(callback => fse.copy(path.join(compositeModulePath, 'node_modules'), path.join(modulePath, 'node_modules'), callback))
          .tap(() => this.options.verbose && this.serverless.cli.log(`Copy modules: ${modulePath} [${_.now() - startCopy} ms]`))
          .then(() => {
            // Prune extraneous packages - removes not needed ones
            const startPrune = _.now();
            return BbPromise.fromCallback(callback => {
              childProcess.exec('npm prune', {
                cwd: modulePath
              }, callback);
            })
            .tap(() => this.options.verbose && this.serverless.cli.log(`Prune: ${modulePath} [${_.now() - startPrune} ms]`));
          });
        })
        .return();
      });
    });
  }
};
