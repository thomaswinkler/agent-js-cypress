/*
 *  Copyright 2020 EPAM Systems
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

const RPClient = require('@reportportal/client-javascript');

const { entityType, testItemStatuses, logLevels } = require('./constants');
const {
  getScreenshotAttachment,
  getTestStartObject,
  getTestEndObject,
  getHookStartObject,
  getAgentInfo,
  getVideoFile,
} = require('./utils');

const { createMergeLaunchLockFile, deleteMergeLaunchLockFile } = require('./mergeLaunchesUtils');
const { mergeParallelLaunches } = require('./mergeLaunches');

const promiseErrorHandler = (promise, message = '') =>
  promise.catch((err) => {
    console.error(message, err);
  });

const getInitialTestFinishParams = () => ({
  attributes: [],
  description: '',
});

class Reporter {
  constructor(config) {
    const agentInfo = getAgentInfo();
    this.client = new RPClient(config.reporterOptions, agentInfo);
    this.testItemIds = new Map();
    this.hooks = new Map();
    this.config = config;

    this.currentTestFinishParams = getInitialTestFinishParams();

    this.currentTestTempInfo = null;
    this.suitesStackTempInfo = [];
    this.suiteTestCaseIds = new Map();
    this.pendingTestsIds = [];
    this.suiteStatuses = new Map();
  }

  resetCurrentTestFinishParams() {
    this.currentTestFinishParams = getInitialTestFinishParams();
  }

  runStart(launchObj) {
    const { tempId, promise } = this.client.startLaunch(launchObj);
    const { launch, isLaunchMergeRequired } = this.config.reporterOptions;
    if (isLaunchMergeRequired) {
      createMergeLaunchLockFile(launch, tempId);
    }
    promiseErrorHandler(promise, 'Fail to start launch');
    this.tempLaunchId = tempId;
  }

  runEnd() {
    const finishLaunchPromise = this.client
      .finishLaunch(
        this.tempLaunchId,
        Object.assign(
          {
            endTime: new Date().valueOf(),
          },
          this.launchStatus && { status: this.launchStatus },
        ),
      )
      .promise.then(() => {
        this.finish();
      })
      .then(() => {
        const { parallel, autoMerge } = this.config.reporterOptions;
        if (!(parallel && autoMerge)) {
          return Promise.resolve();
        }

        return mergeParallelLaunches(this.client, this.config);
      })
      .catch((error) => {
        console.error(error);
        this.finish(error);
      });
    return finishLaunchPromise;
  }

  suiteStart(suite) {
    const parentId = suite.parentId && this.testItemIds.get(suite.parentId);
    const { tempId, promise } = this.client.startTestItem(suite, this.tempLaunchId, parentId);
    promiseErrorHandler(promise, 'Fail to start suite');
    this.testItemIds.set(suite.id, tempId);
    this.suitesStackTempInfo.push({
      tempId,
      startTime: suite.startTime,
      title: suite.name || '',
      id: suite.id,
      testFileName: suite.testFileName,
    });
  }

  suiteEnd(suite) {
    const suiteId = this.testItemIds.get(suite.id);
    const suiteTestCaseId = this.suiteTestCaseIds.get(suite.title);
    const suiteStatus = this.suiteStatuses.get(suite.title);
    const suiteInfo = this.getCurrentSuiteInfo();

    // if suite fails, also the root suite status must fail
    if (suite.status === testItemStatuses.FAILED && suiteStatus !== testItemStatuses.PASSED) {
      this.suitesStackTempInfo[0].status = testItemStatuses.FAILED;
    }
    this.sendVideoOnFinishSuite(suite);

    const finishTestItemPromise = this.client.finishTestItem(
      suiteId,
      Object.assign(
        {
          endTime: new Date().valueOf(),
        },
        suiteTestCaseId && { testCaseId: suiteTestCaseId },
        suiteStatus && { status: suiteStatus },
        suiteInfo && suiteInfo.description && { description: suiteInfo.description },
        suiteInfo && suiteInfo.attributes && { attributes: suiteInfo.attributes },
      ),
    ).promise;
    promiseErrorHandler(finishTestItemPromise, 'Fail to finish suite');

    this.suitesStackTempInfo.pop();
    suiteTestCaseId && this.suiteTestCaseIds.delete(suite.title);
    suiteStatus && this.suiteStatuses.delete(suite.title);
  }

  testStart(test) {
    const parentId = this.testItemIds.get(test.parentId);
    const startTestObj = getTestStartObject(test);
    const { tempId, promise } = this.client.startTestItem(
      startTestObj,
      this.tempLaunchId,
      parentId,
    );
    promiseErrorHandler(promise, 'Fail to start test');
    this.testItemIds.set(test.id, tempId);
    this.currentTestTempInfo = { tempId, startTime: startTestObj.startTime, test };
    if (this.pendingTestsIds.includes(test.id)) {
      this.testEnd(test);
    }
  }

  sendVideoOnFinishSuite(suite) {
    if (!this.suitesStackTempInfo.length || suite.id !== this.suitesStackTempInfo[0].id) {
      return;
    }
    // do not upload video if root suite passes and videoUploadOnPasses is false
    const videoUploadOnPasses = this.config.reporterOptions.videoUploadOnPasses || false;
    const rootSuite = this.suitesStackTempInfo[0];
    const failed = rootSuite.status && rootSuite.status === testItemStatuses.FAILED;
    if (!failed && !videoUploadOnPasses) {
      return;
    }

    const testFileName = this.suitesStackTempInfo[0].testFileName;
    if (!testFileName) return;

    const videosFolder = this.config.reporterOptions.videosFolder;
    const specFileName = testFileName.split('/').pop();
    const videoFileDetails = getVideoFile(specFileName, videosFolder);
    if (!videoFileDetails) return;

    const suiteId = this.testItemIds.get(suite.id);
    const sendVideoPromise = this.client.sendLog(
      suiteId,
      {
        message: `Video: '${suite.title}' (${specFileName}.mp4)`,
        level: logLevels.INFO,
        time: new Date().valueOf(),
      },
      videoFileDetails,
    ).promise;
    promiseErrorHandler(sendVideoPromise, 'Fail to save video');
  }

  testEnd(test) {
    let testId = this.testItemIds.get(test.id);
    if (!testId) {
      this.testStart(test);
      testId = this.testItemIds.get(test.id);
    }

    const testInfo = Object.assign({}, test, this.currentTestFinishParams);
    const finishTestItemPromise = this.client.finishTestItem(
      testId,
      getTestEndObject(testInfo, this.config.reporterOptions.skippedIssue),
    ).promise;
    promiseErrorHandler(finishTestItemPromise, 'Fail to finish test');
    this.resetCurrentTestFinishParams();
    this.currentTestTempInfo = null;
  }

  testPending(test) {
    // if test has not been started, save test.id to finish in testStart().
    // if testStarted() has been called, call testEnd() directly.
    if (this.testItemIds.get(test.id) != null) {
      this.testEnd(test);
    } else {
      this.pendingTestsIds.push(test.id);
    }
  }

  hookStart(hook) {
    const hookStartObject = getHookStartObject(hook);
    switch (hookStartObject.type) {
      case entityType.BEFORE_SUITE:
        hookStartObject.startTime = this.getCurrentSuiteInfo().startTime - 1;
        break;
      case entityType.BEFORE_METHOD:
        hookStartObject.startTime = this.currentTestTempInfo
          ? this.currentTestTempInfo.startTime - 1
          : hookStartObject.startTime;
        break;
      default:
        break;
    }
    this.hooks.set(hook.id, hookStartObject);
  }

  hookEnd(hook) {
    const startedHook = this.hooks.get(hook.id);
    if (!startedHook) return;
    const { tempId, promise } = this.client.startTestItem(
      startedHook,
      this.tempLaunchId,
      this.testItemIds.get(hook.parentId),
    );
    promiseErrorHandler(promise, 'Fail to start hook');

    const finishHookPromise = this.client.finishTestItem(tempId, {
      status: hook.status,
      endTime: new Date().valueOf(),
    }).promise;
    this.hooks.delete(hook.id);
    promiseErrorHandler(finishHookPromise, 'Fail to finish hook');
  }

  getCurrentSuiteInfo() {
    return this.suitesStackTempInfo.length
      ? this.suitesStackTempInfo[this.suitesStackTempInfo.length - 1]
      : undefined;
  }

  getCurrentSuiteId() {
    const currentSuiteInfo = this.getCurrentSuiteInfo();
    return currentSuiteInfo && currentSuiteInfo.tempId;
  }

  sendLog(tempId, { level, message = '', file, time }) {
    const promise = this.client.sendLog(
      tempId,
      {
        message,
        level,
        time: time || new Date().valueOf(),
      },
      file,
    ).promise;
    promiseErrorHandler(promise, 'Fail to send log');
  }

  sendLogToCurrentItem(log) {
    const tempItemId =
      (this.currentTestTempInfo && this.currentTestTempInfo.tempId) || this.getCurrentSuiteId();
    tempItemId && this.sendLog(tempItemId, log);
  }

  sendLaunchLog(log) {
    this.sendLog(this.tempLaunchId, log);
  }

  addAttributes(attributes) {
    if (this.currentTestTempInfo == null && this.getCurrentSuiteInfo() != null) {
      this.getCurrentSuiteInfo().attributes = attributes;
    } else {
      this.currentTestFinishParams.attributes = this.currentTestFinishParams.attributes.concat(
        attributes || [],
      );
    }
  }

  setDescription(description) {
    if (this.currentTestTempInfo == null && this.getCurrentSuiteInfo() != null) {
      this.getCurrentSuiteInfo().description = description;
    } else {
      this.currentTestFinishParams.description = description;
    }
  }

  setTestCaseId({ testCaseId, suiteTitle }) {
    if (suiteTitle) {
      this.suiteTestCaseIds.set(suiteTitle, testCaseId);
    } else {
      Object.assign(this.currentTestFinishParams, testCaseId && { testCaseId });
    }
  }

  setTestItemStatus({ status, suiteTitle }) {
    if (suiteTitle) {
      this.suiteStatuses.set(suiteTitle, status);
      const rootSuite = this.suitesStackTempInfo.length && this.suitesStackTempInfo[0];
      if (rootSuite && status === testItemStatuses.FAILED) {
        this.suitesStackTempInfo[0].status = status;
      }
    } else {
      Object.assign(this.currentTestFinishParams, status && { status });
    }
  }

  setLaunchStatus({ status }) {
    this.launchStatus = status;
  }

  sendScreenshot(screenshotInfo, logMessage) {
    if (!screenshotInfo) return;

    const tempItemId = this.currentTestTempInfo && this.currentTestTempInfo.tempId;
    const fileName = screenshotInfo.path;

    if (!fileName || !tempItemId) return;

    const level = fileName && fileName.includes('(failed)') ? logLevels.ERROR : logLevels.INFO;
    const file = getScreenshotAttachment(fileName);
    if (!file) return;

    const message = logMessage || `screenshot ${file.name}`;

    const sendScreenshotsPromise = this.client.sendLog(
      tempItemId,
      {
        message,
        level,
        time: new Date().valueOf(),
      },
      file,
    ).promise;
    promiseErrorHandler(sendScreenshotsPromise, 'Fail to save screenshot.');
  }

  // eslint-disable-next-line no-unused-vars
  exceptionHandler(error, origin) {
    this.finish(error);
  }

  finish(error) {
    const { launch, isLaunchMergeRequired } = this.config.reporterOptions;
    if (isLaunchMergeRequired) {
      if (error) {
        console.log(
          `Delete merge launch lock file for launch ${launch} with id ${this.tempLaunchId}.`,
        );
      }
      deleteMergeLaunchLockFile(launch, this.tempLaunchId);
    }
  }
}

module.exports = Reporter;
