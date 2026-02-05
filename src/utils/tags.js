/**
 * Validate and normalize tags array
 * @param {Array<string>|null|undefined} tags - Tags array to validate
 * @returns {Object} - { tags: Array<string>|null } or { error: string }
 */
function validateAndNormalizeTags(tags) {
  if (tags === null || tags === undefined) {
    return null;
  }
  
  if (!Array.isArray(tags)) {
    return { error: 'Tags must be an array' };
  }
  
  if (tags.length > 20) {
    return { error: 'Maximum 20 tags allowed' };
  }
  
  const normalized = [];
  const seen = new Set();
  
  for (const tag of tags) {
    if (typeof tag !== 'string') {
      return { error: 'Each tag must be a string' };
    }
    
    const trimmed = tag.trim();
    if (!trimmed) {
      continue; // Skip empty tags
    }
    
    if (trimmed.length > 50) {
      return { error: 'Each tag must be 50 characters or less' };
    }
    
    const lowercase = trimmed.toLowerCase();
    if (!seen.has(lowercase)) {
      seen.add(lowercase);
      normalized.push(lowercase);
    }
  }
  
  return { tags: normalized.length > 0 ? normalized : null };
}

module.exports = {
  validateAndNormalizeTags
};
