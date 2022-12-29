/* eslint-disable no-underscore-dangle */
/* eslint-disable prefer-template */
/*
 *  Copyright 2022 EPAM Systems
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

const fs = require('fs');
const glob = require('glob');
const path = require('path');
const minimatch = require('minimatch');
const { entityType, hookTypesMap, testItemStatuses } = require('./constants');
const pjson = require('./../package.json');

const { FAILED, PASSED, SKIPPED } = testItemStatuses;

const base64Encode = (file) => {
  const bitmap = fs.readFileSync(file);
  return Buffer.from(bitmap).toString('base64');
};

const fileNameForString = (filename) => {
  if (filename == null) return filename;
  return filename.replace(/["':]/g, '');
};

const screenshotGlobPattern = (screenshotsFolder, testTitle) => {
  const normalizedTestTitle = fileNameForString(testTitle || '');
  const folder = (screenshotsFolder || '**').replace(/\/$/);
  let pattern = folder !== '**' ? screenshotsFolder + '/**' : '**';
  pattern += `/*${normalizedTestTitle}*.png`;
  return pattern;
};

const getCustomScreenshots = (screenshotsFolder, customScreenshotsFileNames, specFilePath) => {
  if (!customScreenshotsFileNames.length) return [];

  const base = screenshotsFolder || '**';
  const specFileName = path.parse(specFilePath).base;

  return [...new Set(customScreenshotsFileNames)].reduce((screenshots, screenshotFilename) => {
    const screenshotFiles = glob.sync(`${base}/${specFileName}/${screenshotFilename}.png`) || [];
    if (screenshotFiles.length) {
      return screenshots.concat([
        {
          name: screenshotFilename.split('/').pop(),
          type: 'image/png',
          content: base64Encode(screenshotFiles[0]),
        },
      ]);
    }
    return screenshots;
  }, []);
};

const filteredScreenshotsForSuites = (files, spec, suites, screenshotsFolder) => {
  return files
    .filter((s) => suites.some((suite) => s.includes(fileNameForString(suite))))
    .filter((s) => {
      const suitesInPath = s
        .slice(`${screenshotsFolder}/${spec}`.length + 1)
        .split(' -- ')
        .filter((c) => !c.includes('after each hook'))
        .slice(0, -1);
      return suitesInPath.toString() === suites.toString();
    });
};

const getPassedScreenshots = (screenshotsFolder, test, suites) => {
  if (!test || !test.title || !test.testFileName) {
    return undefined;
  }

  const testTitle = test.title;
  const testFileName = path.parse(test.testFileName).base;
  const folder = `${screenshotsFolder}/${testFileName}`;
  const patternBase = screenshotGlobPattern(folder, testTitle);
  const allTestScreenshots = glob.sync(patternBase) || [];

  let filteredScreenshots = allTestScreenshots
    // filter screenshots with "(failed)" suffix
    .filter((s) => !s.match(/\(failed\)\.png$/))
    // ignore screenshots in subfolders
    .filter((s) => s.slice(screenshotsFolder.length + 1).split('/').length <= 2);

  if (suites) {
    filteredScreenshots = filteredScreenshotsForSuites(
      filteredScreenshots,
      testFileName,
      suites,
      screenshotsFolder,
    );
  }

  return (filteredScreenshots || []).map((file, index) => ({
    name: `${testTitle}-${index + 1}`,
    type: 'image/png',
    content: base64Encode(file),
  }));
};

const getFailedScreenshot = (screenshotsFolder, test, testSuites) => {
  if (!test || !test.title || !test.testFileName) {
    return undefined;
  }

  const testTitle = test.title;
  const testFileName = path.parse(test.testFileName).base;
  const folder = `${screenshotsFolder}/${testFileName}`;
  const patternBase = screenshotGlobPattern(folder, testTitle);

  let suites = testSuites;
  if (!Array.isArray(suites)) {
    suites = [suites.toString];
  }
  const allTestScreenshots = glob.sync(patternBase) || [];
  let filteredScreenshots = allTestScreenshots
    // get screenshot with "(failed)" suffix
    .filter((s) => s.match(/\(failed\)\.png$/))
    // ignore screenshots in subfolders
    .filter((s) => s.slice(screenshotsFolder.length + 1).split('/').length <= 2);

  // match suites. there might be tests with same name in different suites
  if (suites) {
    filteredScreenshots = filteredScreenshotsForSuites(
      filteredScreenshots,
      testFileName,
      suites,
      screenshotsFolder,
    );
  }

  return filteredScreenshots.length
    ? {
        name: `${testTitle} (failed)`,
        type: 'image/png',
        content: base64Encode(filteredScreenshots[0]),
      }
    : undefined;
};

const getVideoFile = (specFileName) => {
  if (specFileName == null) return specFileName;
  const fileName = specFileName.toLowerCase().endsWith('.mp4')
    ? specFileName
    : `${specFileName}.mp4`;
  const videoFile = glob.sync(`**/${fileName}`);
  if (videoFile.length) {
    return {
      name: fileName,
      type: 'video/mp4',
      content: base64Encode(videoFile[0]),
    };
  }

  return undefined;
};

const getCodeRef = (testItemPath, testFileName) =>
  `${testFileName.replace(/\\/g, '/')}/${testItemPath.join('/')}`;

const getAgentInfo = () => ({
  version: pjson.version,
  name: pjson.name,
});

const getSystemAttributes = (config) => {
  const agentInfo = getAgentInfo();
  const systemAttributes = [
    {
      key: 'agent',
      value: `${agentInfo.name}|${agentInfo.version}`,
      system: true,
    },
  ];
  if (config.reporterOptions.skippedIssue === false) {
    const skippedIssueAttribute = {
      key: 'skippedIssue',
      value: 'false',
      system: true,
    };
    systemAttributes.push(skippedIssueAttribute);
  }
  return systemAttributes;
};

const getConfig = (initialConfig) => {
  const attributes = initialConfig.reporterOptions.attributes || [];

  if (
    initialConfig.reporterOptions.parallel &&
    initialConfig.reporterOptions.autoMerge &&
    process.env.CI_BUILD_ID
  ) {
    attributes.push({ value: process.env.CI_BUILD_ID });
  }

  return {
    ...initialConfig,
    reporterOptions: {
      ...initialConfig.reporterOptions,
      attributes,
      token: process.env.RP_TOKEN || initialConfig.reporterOptions.token,
    },
  };
};

const getLaunchStartObject = (config) => {
  const launchAttributes = (config.reporterOptions.attributes || []).concat(
    getSystemAttributes(config),
  );

  return {
    launch: config.reporterOptions.launch,
    description: config.reporterOptions.description,
    attributes: launchAttributes,
    rerun: config.reporterOptions.rerun,
    rerunOf: config.reporterOptions.rerunOf,
    mode: config.reporterOptions.mode,
    startTime: new Date().valueOf(),
  };
};

const tagsFromString = (str) => {
  if (!str) return str;
  return str.split(' ').map((tag) => ({ value: tag }));
};

const getSuiteStartObject = (suite, testFileName) => {
  // eslint-disable-next-line no-underscore-dangle
  const tags = suite._testConfig && suite._testConfig.tags;
  return {
    id: suite.id,
    type: entityType.SUITE,
    name: suite.title.slice(0, 255).toString(),
    startTime: new Date().valueOf(),
    description: suite.description,
    // add attributes for cypress grep tags
    attributes: tagsFromString(tags) || [],
    codeRef: getCodeRef(suite.titlePath(), testFileName),
    parentId: !suite.root ? suite.parent.id : undefined,
    testFileName,
  };
};

const getSuiteEndObject = (suite) => {
  let failed = false;
  if (suite.tests != null) {
    const states = suite.tests.map((test) => test.state);
    failed = states.includes(testItemStatuses.FAILED);
  }
  return {
    id: suite.id,
    status: failed ? testItemStatuses.FAILED : undefined,
    title: suite.title,
    endTime: new Date().valueOf(),
  };
};

const getTestInfo = (test, testFileName, status, err) => {
  // read cypress-grep tags from runnable.
  // if tags of test are inherited from it's parent ignore them
  let testTags;
  if (test._testConfig && test._testConfig.unverifiedTestConfig) {
    testTags = test._testConfig.unverifiedTestConfig.tags;
  }
  const parentTags = test.parent._testConfig && test.parent._testConfig.tags;
  if (testTags && parentTags === testTags) {
    testTags = undefined;
  }

  return {
    id: test.id,
    status: status || (test.state === 'pending' ? testItemStatuses.SKIPPED : test.state),
    title: test.title,
    codeRef: getCodeRef(test.titlePath(), testFileName),
    parentId: test.parent.id,
    err: (err && err.message) || err || (test.err && test.err.message),
    testFileName,
    tags: tagsFromString(testTags) || [],
  };
};

const getTestStartObject = (test) => ({
  type: entityType.STEP,
  name: test.title.slice(0, 255).toString(),
  startTime: new Date().valueOf(),
  codeRef: test.codeRef,
  attributes: test.tags,
});

const getTestEndObject = (testInfo, skippedIssue) => {
  const testEndObj = Object.assign(
    {
      endTime: new Date().valueOf(),
      status: testInfo.status,
      attributes: testInfo.attributes,
      description: testInfo.description,
    },
    testInfo.testCaseId && { testCaseId: testInfo.testCaseId },
  );
  if (testInfo.status === SKIPPED && skippedIssue === false) {
    testEndObj.issue = {
      issueType: 'NOT_ISSUE',
    };
  }
  return testEndObj;
};

const getHookInfo = (hook, testFileName, status, err) => {
  const hookRPType = hookTypesMap[hook.hookName];
  let parentId = hook.parent.id;
  if ([entityType.BEFORE_SUITE, entityType.AFTER_SUITE].includes(hookRPType)) {
    parentId = hook.parent.parent && hook.parent.parent.title ? hook.parent.parent.id : undefined;
  }
  return {
    id: hook.failedFromHookId ? `${hook.failedFromHookId}_${hook.id}` : `${hook.hookId}_${hook.id}`,
    hookName: hook.hookName,
    title: hook.title,
    status: status || (hook.state === FAILED ? FAILED : PASSED),
    parentId,
    codeRef: getCodeRef(hook.titlePath(), testFileName),
    err: (err && err.message) || err || (hook.err && hook.err.message),
    testFileName,
  };
};

const getHookStartObject = (hook) => {
  const hookRPType = hookTypesMap[hook.hookName];
  const hookName = hook.title.replace(`"${hook.hookName}" hook:`, '').trim();
  return {
    name: hookName,
    startTime: new Date().valueOf(),
    type: hookRPType,
    codeRef: hook.codeRef,
  };
};
const getFixtureFolderPattern = (config) => {
  return [].concat(config.fixturesFolder ? path.join(config.fixturesFolder, '**', '*') : []);
};

const getExcludeSpecPattern = (config) => {
  // Return cypress >= 10 pattern.
  if (config.excludeSpecPattern) {
    const excludePattern = Array.isArray(config.excludeSpecPattern)
      ? config.excludeSpecPattern
      : [config.excludeSpecPattern];
    return [...excludePattern];
  }

  // Return cypress <= 9 pattern
  const ignoreTestFilesPattern = Array.isArray(config.ignoreTestFiles)
    ? config.ignoreTestFiles
    : [config.ignoreTestFiles] || [];

  return [...ignoreTestFilesPattern];
};

const getSpecPattern = (config) => {
  if (config.specPattern) return [].concat(config.specPattern);

  return Array.isArray(config.testFiles)
    ? config.testFiles.map((file) => path.join(config.integrationFolder, file))
    : [].concat(path.join(config.integrationFolder, config.testFiles));
};

const getTotalSpecs = (config) => {
  if (!config.testFiles && !config.specPattern)
    throw new Error('Configuration property not set! Neither for cypress <= 9 nor cypress >= 10');

  const specPattern = getSpecPattern(config);

  const excludeSpecPattern = getExcludeSpecPattern(config);

  const options = {
    sort: true,
    absolute: true,
    nodir: true,
    ignore: [config.supportFile].concat(getFixtureFolderPattern(config)),
  };

  const doesNotMatchAllIgnoredPatterns = (file) =>
    excludeSpecPattern.every(
      (pattern) => !minimatch(file, pattern, { dot: true, matchBase: true }),
    );

  const globResult = specPattern.reduce(
    (files, pattern) => files.concat(glob.sync(pattern, options) || []),
    [],
  );

  return globResult.filter(doesNotMatchAllIgnoredPatterns).length;
};

module.exports = {
  fileNameForString,
  base64Encode,
  getFailedScreenshot,
  getPassedScreenshots,
  getCustomScreenshots,
  getAgentInfo,
  getCodeRef,
  getSystemAttributes,
  getLaunchStartObject,
  getSuiteStartObject,
  getSuiteEndObject,
  getTestStartObject,
  getTestInfo,
  getTestEndObject,
  getHookInfo,
  getHookStartObject,
  getTotalSpecs,
  getConfig,
  getExcludeSpecPattern,
  getFixtureFolderPattern,
  getSpecPattern,
  getVideoFile,
};
