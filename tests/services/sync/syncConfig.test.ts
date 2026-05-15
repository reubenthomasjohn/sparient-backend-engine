import { describe, it, expect } from 'vitest';
import { getEffectiveSyncConfig } from '../../../src/services/sync/syncConfig';

// Pure unit tests — no DB, no mocks. Drives getEffectiveSyncConfig with
// hand-rolled Institution shapes (only id + syncConfig are read).
const inst = (syncConfig: unknown) => ({ id: 'inst-test', syncConfig: syncConfig as any });

describe('getEffectiveSyncConfig', () => {
  describe('defaults', () => {
    it('returns conservative defaults when syncConfig is null', () => {
      const eff = getEffectiveSyncConfig(inst(null));
      expect(eff.allowedFileTypes).toEqual(['pdf', 'docx', 'pptx', 'xlsx', 'jpg', 'png']);
      expect(eff.allowedCourseStates).toEqual(['available', 'unpublished']);
      expect(eff.excludedCanvasCourseIds).toEqual([]);
      expect(eff.maxFileSizeBytes).toBeNull();
      expect(eff.skipLockedFiles).toBe(false);
      expect(eff.skipHiddenFiles).toBe(false);
    });

    it('returns defaults when syncConfig is {}', () => {
      const eff = getEffectiveSyncConfig(inst({}));
      expect(eff.allowedFileTypes).toEqual(['pdf', 'docx', 'pptx', 'xlsx', 'jpg', 'png']);
    });

    it('coerces non-object values (scalar, array) to defaults', () => {
      // A manual DB edit setting syncConfig to a scalar or array shouldn't crash
      // the sync — coerceToObject normalizes to {} so per-field defaults apply.
      expect(getEffectiveSyncConfig(inst('garbage')).allowedFileTypes).toContain('pdf');
      expect(getEffectiveSyncConfig(inst([1, 2, 3])).allowedFileTypes).toContain('pdf');
      expect(getEffectiveSyncConfig(inst(42)).allowedFileTypes).toContain('pdf');
    });
  });

  describe('field overrides', () => {
    it('applies a valid allowedFileTypes override', () => {
      const eff = getEffectiveSyncConfig(inst({ allowedFileTypes: ['pdf', 'docx'] }));
      expect(eff.allowedFileTypes).toEqual(['pdf', 'docx']);
    });

    it('treats empty allowedFileTypes array as "use defaults" (open-by-default sugar)', () => {
      const eff = getEffectiveSyncConfig(inst({ allowedFileTypes: [] }));
      expect(eff.allowedFileTypes).toEqual(['pdf', 'docx', 'pptx', 'xlsx', 'jpg', 'png']);
    });

    it('treats empty allowedCourseStates array as "use defaults"', () => {
      const eff = getEffectiveSyncConfig(inst({ allowedCourseStates: [] }));
      expect(eff.allowedCourseStates).toEqual(['available', 'unpublished']);
    });

    it('normalizes "jpeg" alias to "jpg"', () => {
      const eff = getEffectiveSyncConfig(inst({ allowedFileTypes: ['jpeg', 'pdf'] }));
      expect(eff.allowedFileTypes).toEqual(['jpg', 'pdf']);
    });

    it('respects an explicit maxFileSizeBytes', () => {
      const eff = getEffectiveSyncConfig(inst({ maxFileSizeBytes: 5000000 }));
      expect(eff.maxFileSizeBytes).toBe(5000000);
    });

    it('passes skipLockedFiles / skipHiddenFiles through', () => {
      const eff = getEffectiveSyncConfig(
        inst({ skipLockedFiles: true, skipHiddenFiles: true }),
      );
      expect(eff.skipLockedFiles).toBe(true);
      expect(eff.skipHiddenFiles).toBe(true);
    });
  });

  describe('invalid input → fallback', () => {
    it('falls back to all defaults when an enum value is unknown', () => {
      const eff = getEffectiveSyncConfig(
        inst({ allowedFileTypes: ['pdf', 'made-up-format'] }),
      );
      // Should NOT contain the bogus value; defaults applied.
      expect(eff.allowedFileTypes).not.toContain('made-up-format');
      expect(eff.allowedFileTypes).toEqual(['pdf', 'docx', 'pptx', 'xlsx', 'jpg', 'png']);
    });

    it('falls back to defaults when maxFileSizeBytes is negative', () => {
      const eff = getEffectiveSyncConfig(inst({ maxFileSizeBytes: -1 }));
      expect(eff.maxFileSizeBytes).toBeNull();
    });

    it('falls back to defaults when a field has the wrong type', () => {
      const eff = getEffectiveSyncConfig(
        inst({ excludedCanvasCourseIds: 'should-be-an-array' }),
      );
      expect(eff.excludedCanvasCourseIds).toEqual([]);
    });
  });

  describe('derived hot-path fields', () => {
    it('builds excludedCourseIdSet from the array', () => {
      const eff = getEffectiveSyncConfig(
        inst({ excludedCanvasCourseIds: ['course-1', 'course-2'] }),
      );
      expect(eff.excludedCourseIdSet).toBeInstanceOf(Set);
      expect(eff.excludedCourseIdSet.has('course-1')).toBe(true);
      expect(eff.excludedCourseIdSet.has('course-2')).toBe(true);
      expect(eff.excludedCourseIdSet.has('not-excluded')).toBe(false);
    });

    it('flattens allowedFileTypes into allowedMimeTypes', () => {
      const eff = getEffectiveSyncConfig(inst({ allowedFileTypes: ['pdf', 'jpg'] }));
      expect(eff.allowedMimeTypes).toContain('application/pdf');
      expect(eff.allowedMimeTypes).toContain('image/jpeg');
    });

    it('flattens allowedFileTypes into allowedExtensions (with multi-extension types)', () => {
      const eff = getEffectiveSyncConfig(inst({ allowedFileTypes: ['jpg'] }));
      // jpg type covers both .jpg and .jpeg extensions
      expect(eff.allowedExtensions.has('.jpg')).toBe(true);
      expect(eff.allowedExtensions.has('.jpeg')).toBe(true);
    });

    it('flattens rtf alternate mime types', () => {
      const eff = getEffectiveSyncConfig(inst({ allowedFileTypes: ['rtf'] }));
      expect(eff.allowedMimeTypes).toContain('application/rtf');
      expect(eff.allowedMimeTypes).toContain('text/rtf');
    });
  });
});
