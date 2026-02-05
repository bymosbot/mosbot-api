const { validateAndNormalizeTags } = require('../tags');

describe('validateAndNormalizeTags', () => {
  describe('null and undefined handling', () => {
    test('should return null for null input', () => {
      expect(validateAndNormalizeTags(null)).toBeNull();
    });

    test('should return null for undefined input', () => {
      expect(validateAndNormalizeTags(undefined)).toBeNull();
    });
  });

  describe('type validation', () => {
    test('should return error for non-array input', () => {
      expect(validateAndNormalizeTags('not-an-array')).toEqual({
        error: 'Tags must be an array'
      });
    });

    test('should return error for number input', () => {
      expect(validateAndNormalizeTags(123)).toEqual({
        error: 'Tags must be an array'
      });
    });

    test('should return error for object input', () => {
      expect(validateAndNormalizeTags({})).toEqual({
        error: 'Tags must be an array'
      });
    });
  });

  describe('array length validation', () => {
    test('should return error for more than 20 tags', () => {
      const tags = Array(21).fill('tag');
      expect(validateAndNormalizeTags(tags)).toEqual({
        error: 'Maximum 20 tags allowed'
      });
    });

    test('should accept exactly 20 tags', () => {
      const tags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
      const result = validateAndNormalizeTags(tags);
      expect(result.error).toBeUndefined();
      expect(result.tags).toHaveLength(20);
    });
  });

  describe('tag type validation', () => {
    test('should return error for non-string tag', () => {
      expect(validateAndNormalizeTags([123])).toEqual({
        error: 'Each tag must be a string'
      });
    });

    test('should return error for mixed types', () => {
      expect(validateAndNormalizeTags(['tag', 123])).toEqual({
        error: 'Each tag must be a string'
      });
    });
  });

  describe('tag length validation', () => {
    test('should return error for tag longer than 50 characters', () => {
      const longTag = 'a'.repeat(51);
      expect(validateAndNormalizeTags([longTag])).toEqual({
        error: 'Each tag must be 50 characters or less'
      });
    });

    test('should accept tag with exactly 50 characters', () => {
      const tag = 'a'.repeat(50);
      const result = validateAndNormalizeTags([tag]);
      expect(result.error).toBeUndefined();
      expect(result.tags).toEqual([tag]);
    });
  });

  describe('normalization', () => {
    test('should convert tags to lowercase', () => {
      const result = validateAndNormalizeTags(['TAG', 'Tag', 'tag']);
      expect(result.tags).toEqual(['tag']);
    });

    test('should trim whitespace', () => {
      const result = validateAndNormalizeTags(['  tag  ', ' tag ', 'tag']);
      expect(result.tags).toEqual(['tag']);
    });

    test('should remove empty tags', () => {
      const result = validateAndNormalizeTags(['tag', '', '   ', 'another']);
      expect(result.tags).toEqual(['tag', 'another']);
    });

    test('should remove duplicates (case-insensitive)', () => {
      const result = validateAndNormalizeTags(['tag', 'TAG', 'Tag', 'another']);
      expect(result.tags).toEqual(['tag', 'another']);
    });

    test('should preserve order of first occurrence', () => {
      const result = validateAndNormalizeTags(['first', 'second', 'FIRST', 'third']);
      expect(result.tags).toEqual(['first', 'second', 'third']);
    });
  });

  describe('edge cases', () => {
    test('should return null for empty array after normalization', () => {
      const result = validateAndNormalizeTags(['', '   ', '']);
      expect(result.tags).toBeNull();
    });

    test('should handle array with only empty strings', () => {
      const result = validateAndNormalizeTags(['', '   ', '\t', '\n']);
      expect(result.tags).toBeNull();
    });

    test('should handle special characters', () => {
      const result = validateAndNormalizeTags(['tag-1', 'tag_2', 'tag.3', 'tag@4']);
      expect(result.tags).toEqual(['tag-1', 'tag_2', 'tag.3', 'tag@4']);
    });

    test('should handle unicode characters', () => {
      const result = validateAndNormalizeTags(['täg', '标签', 'тег']);
      expect(result.tags).toEqual(['täg', '标签', 'тег']);
    });
  });

  describe('real-world scenarios', () => {
    test('should normalize mixed case tags with duplicates', () => {
      const result = validateAndNormalizeTags([
        'Bug',
        'bug',
        'BUG',
        'Feature',
        'feature',
        '  High Priority  ',
        'high priority'
      ]);
      expect(result.tags).toEqual(['bug', 'feature', 'high priority']);
    });

    test('should handle maximum valid tags', () => {
      const tags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
      const result = validateAndNormalizeTags(tags);
      expect(result.error).toBeUndefined();
      expect(result.tags).toHaveLength(20);
    });
  });
});
