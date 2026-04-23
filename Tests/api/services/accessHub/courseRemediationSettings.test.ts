import { describe, it, expect } from 'vitest';
import {
  buildSettingsData,
  parsePatchSettingsBody,
} from '@/services/accessHub/courseRemediationSettings';

const institution = (writebackOptIn: boolean) => ({
  writebackOptIn,
});

const course = (writebackOptIn: boolean | null, canvasCourseId = 'canvas-99') => ({
  canvasCourseId,
  writebackOptIn,
});

describe('buildSettingsData', () => {
  it('mode=opt_out when effective writeback is true', () => {
    const data = buildSettingsData(
      course(true),
      institution(false),
    );
    expect(data.canvas_course_id).toBe('canvas-99');
    expect(data.remediation_delivery).toEqual({
      mode: 'opt_out',
      effective_writeback_opt_in: true,
      course_writeback_opt_in: true,
      institution_writeback_opt_in: false,
    });
  });

  it('mode=opt_in when effective writeback is false (course override)', () => {
    const data = buildSettingsData(course(false), institution(true));
    expect(data.remediation_delivery.mode).toBe('opt_in');
    expect(data.remediation_delivery.effective_writeback_opt_in).toBe(false);
    expect(data.remediation_delivery.course_writeback_opt_in).toBe(false);
    expect(data.remediation_delivery.institution_writeback_opt_in).toBe(true);
  });

  it('falls back to institution when course override is null', () => {
    const data = buildSettingsData(course(null), institution(true));
    expect(data.remediation_delivery.mode).toBe('opt_out');
    expect(data.remediation_delivery.effective_writeback_opt_in).toBe(true);
    expect(data.remediation_delivery.course_writeback_opt_in).toBeNull();
    expect(data.remediation_delivery.institution_writeback_opt_in).toBe(true);
  });

  it('mode=opt_in when both institution and course are false', () => {
    const data = buildSettingsData(course(false), institution(false));
    expect(data.remediation_delivery.mode).toBe('opt_in');
    expect(data.remediation_delivery.effective_writeback_opt_in).toBe(false);
  });

  it('mode invariant: mode===opt_out iff effective_writeback_opt_in===true', () => {
    const cases: [boolean | null, boolean][] = [
      [true, false], [false, false], [null, true], [null, false], [true, true],
    ];
    for (const [co, io] of cases) {
      const d = buildSettingsData(course(co), institution(io));
      const rd = d.remediation_delivery;
      expect(rd.mode === 'opt_out').toBe(rd.effective_writeback_opt_in);
    }
  });
});

describe('parsePatchSettingsBody', () => {
  it('accepts opt_in', () => {
    const body = parsePatchSettingsBody({ remediation_delivery: { mode: 'opt_in' } });
    expect(body.remediation_delivery.mode).toBe('opt_in');
  });

  it('accepts opt_out', () => {
    const body = parsePatchSettingsBody({ remediation_delivery: { mode: 'opt_out' } });
    expect(body.remediation_delivery.mode).toBe('opt_out');
  });

  it('throws 400 for invalid mode', () => {
    expect(() =>
      parsePatchSettingsBody({ remediation_delivery: { mode: 'bad' } }),
    ).toThrow();
  });

  it('throws 400 when remediation_delivery is missing', () => {
    expect(() => parsePatchSettingsBody({})).toThrow();
  });

  it('throws 400 when mode is missing inside remediation_delivery', () => {
    expect(() =>
      parsePatchSettingsBody({ remediation_delivery: {} }),
    ).toThrow();
  });
});
