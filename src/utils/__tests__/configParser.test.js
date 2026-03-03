/**
 * Tests for configParser.js - JSON5 config parsing with fallback to JSON
 */

describe('parseOpenClawConfig', () => {
  let parseOpenClawConfig;

  beforeEach(() => {
    jest.resetModules();
    const configParser = require('../configParser');
    parseOpenClawConfig = configParser.parseOpenClawConfig;
  });

  it('should parse valid JSON content', () => {
    const content = '{"key": "value"}';
    const result = parseOpenClawConfig(content);
    expect(result).toEqual({ key: 'value' });
  });

  it('should parse OpenClaw config structure', () => {
    const content = JSON.stringify({
      agents: {
        defaults: {
          model: {
            primary: 'openrouter/anthropic/claude-sonnet-4.5',
          },
        },
      },
    });

    const result = parseOpenClawConfig(content);
    expect(result.agents.defaults.model.primary).toBe('openrouter/anthropic/claude-sonnet-4.5');
  });

  it('should handle empty object', () => {
    const content = '{}';
    const result = parseOpenClawConfig(content);
    expect(result).toEqual({});
  });

  it('should handle nested objects', () => {
    const content = JSON.stringify({
      level1: {
        level2: {
          level3: 'value',
        },
      },
    });

    const result = parseOpenClawConfig(content);
    expect(result.level1.level2.level3).toBe('value');
  });

  it('should handle arrays', () => {
    const content = JSON.stringify({
      items: ['a', 'b', 'c'],
    });

    const result = parseOpenClawConfig(content);
    expect(result.items).toEqual(['a', 'b', 'c']);
  });

  // Test JSON5 features if json5 is available
  // Note: json5 is listed as a dependency, so it should be available
  it('should parse JSON5 with trailing commas if json5 is available', () => {
    // Check if json5 is available
    let json5Available = false;
    try {
      require('json5');
      json5Available = true;
    } catch (_) {
      json5Available = false;
    }

    if (json5Available) {
      const content = '{"key": "value",}'; // Trailing comma - valid JSON5
      const result = parseOpenClawConfig(content);
      expect(result).toEqual({ key: 'value' });
    } else {
      // If json5 is not available, this should throw
      const content = '{"key": "value",}';
      expect(() => {
        parseOpenClawConfig(content);
      }).toThrow(/Failed to parse config/);
    }
  });

  it('should throw error with helpful message when JSON.parse fails and json5 not available', () => {
    // Mock json5 to be unavailable
    jest.resetModules();
    jest.mock('json5', () => {
      throw new Error("Cannot find module 'json5'");
    });

    const configParser = require('../configParser');
    const parse = configParser.parseOpenClawConfig;

    const content = '{"key": "value",}'; // Trailing comma - invalid JSON

    expect(() => {
      parse(content);
    }).toThrow(/Failed to parse config/);
    expect(() => {
      parse(content);
    }).toThrow(/Install 'json5' package/);
  });

  it('should throw error for invalid JSON syntax', () => {
    const content = '{key: "value"}'; // Missing quotes around key

    expect(() => {
      parseOpenClawConfig(content);
    }).toThrow();
  });

  it('should throw error for malformed JSON', () => {
    const content = '{"key": "value"'; // Missing closing brace

    expect(() => {
      parseOpenClawConfig(content);
    }).toThrow();
  });
});
