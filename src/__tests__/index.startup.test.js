describe('index startup lifecycle', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('runs docs link startup reconciliation in non-test mode', async () => {
    const startupListen = jest.fn((port, callback) => {
      if (callback) callback();
      return { close: jest.fn() };
    });
    const runMigrations = jest.fn().mockResolvedValue(undefined);
    const reconcileDocsLinksOnStartup = jest.fn().mockResolvedValue({
      main: { action: 'unchanged' },
      agents: [],
    });
    const startSessionUsagePoller = jest.fn();
    const startPricingRefreshJob = jest.fn();
    const startActivityIngestionPollers = jest.fn();
    const warnIfDeviceAuthNotConfigured = jest.fn();

    jest.doMock('../db/runMigrations', () => runMigrations);
    jest.doMock('../services/sessionUsageService', () => ({
      startSessionUsagePoller,
    }));
    jest.doMock('../services/modelPricingService', () => ({
      startPricingRefreshJob,
    }));
    jest.doMock('../services/activityIngestionService', () => ({
      startActivityIngestionPollers,
    }));
    jest.doMock('../services/openclawGatewayClient', () => ({
      warnIfDeviceAuthNotConfigured,
    }));
    jest.doMock('../services/docsLinkReconciliationService', () => ({
      reconcileDocsLinksOnStartup,
    }));
    jest.doMock('../utils/logger', () => ({
      info: jest.fn(),
      error: jest.fn(),
    }));
    jest.doMock('../config', () => ({
      validate: jest.fn(),
      corsOrigin: 'http://localhost:5173',
      timezone: 'America/New_York',
      port: 3000,
      nodeEnv: 'development',
      polling: {
        sessionUsageIntervalMs: 60000,
        modelPricingRefreshIntervalMs: 3600000,
      },
    }));
    jest.doMock('express', () => {
      const express = jest.requireActual('express');
      express.application.listen = startupListen;
      return express;
    });

    await jest.isolateModulesAsync(async () => {
      require('../index');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(runMigrations).toHaveBeenCalledWith({ endPool: false });
    expect(startupListen).toHaveBeenCalled();
    expect(reconcileDocsLinksOnStartup).toHaveBeenCalledTimes(1);
    expect(startSessionUsagePoller).toHaveBeenCalled();
    expect(startPricingRefreshJob).toHaveBeenCalled();
    expect(startActivityIngestionPollers).toHaveBeenCalled();
    expect(warnIfDeviceAuthNotConfigured).toHaveBeenCalled();
  });
});
