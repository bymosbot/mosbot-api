jest.mock('ws', () => {
  class MockWebSocket {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.handlers = {};
      this.sent = [];
      MockWebSocket.instances.push(this);

      setImmediate(() => {
        if (this.handlers.open) this.handlers.open();
      });
    }

    on(event, cb) {
      this.handlers[event] = cb;
    }

    send(raw) {
      const msg = JSON.parse(raw);
      this.sent.push(msg);

      if (msg.method === 'connect') {
        setImmediate(() => {
          this.handlers.message?.(
            JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: true,
              payload: { connected: true },
            }),
          );
        });
      }

      if (msg.method === 'config.get') {
        setImmediate(() => {
          this.handlers.message?.(
            JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: true,
              payload: { raw: '{"ok":true}', hash: 'abc123' },
            }),
          );
        });
      }
    }

    close() {
      // no-op for tests
    }
  }

  MockWebSocket.instances = [];

  return MockWebSocket;
});

const MockWebSocket = require('ws');
const { gatewayWsRpc } = require('./openclawGatewayClient');

describe('openclawGatewayClient insecure fallback handshake', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.OPENCLAW_GATEWAY_URL = 'http://localhost:5173';
    process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token';
    delete process.env.OPENCLAW_DEVICE_ID;
    delete process.env.OPENCLAW_DEVICE_PUBLIC_KEY;
    delete process.env.OPENCLAW_DEVICE_PRIVATE_KEY;
    delete process.env.OPENCLAW_DEVICE_TOKEN;
    MockWebSocket.instances.length = 0;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses backend client identity (not control-ui) when device auth env vars are missing', async () => {
    const result = await gatewayWsRpc('config.get', {});

    expect(result).toEqual({ raw: '{"ok":true}', hash: 'abc123' });
    expect(MockWebSocket.instances).toHaveLength(1);

    const ws = MockWebSocket.instances[0];
    const connectReq = ws.sent.find((msg) => msg.method === 'connect');

    expect(connectReq).toBeDefined();
    expect(connectReq.params.client.id).toBe('gateway-client');
    expect(connectReq.params.client.mode).toBe('backend');
    expect(connectReq.params.client.id).not.toBe('openclaw-control-ui');
  });
});
