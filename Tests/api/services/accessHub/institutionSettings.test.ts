import { describe, it, expect } from 'vitest';
import {
  buildInstitutionSettingsData,
  parsePatchInstitutionSettingsBody,
} from '@/services/accessHub/institutionSettings';

describe('buildInstitutionSettingsData', () => {
  it('returns opt_in mode when writebackOptIn is false', () => {
    const data = buildInstitutionSettingsData({
      id: 'inst-1',
      writebackOptIn: false,
    });
    expect(data).toEqual({
      institution_id: 'inst-1',
      remediation_delivery: { mode: 'opt_in', writeback_opt_in: false },
    });
  });

  it('returns opt_out mode when writebackOptIn is true', () => {
    const data = buildInstitutionSettingsData({
      id: 'inst-2',
      writebackOptIn: true,
    });
    expect(data).toEqual({
      institution_id: 'inst-2',
      remediation_delivery: { mode: 'opt_out', writeback_opt_in: true },
    });
  });

  it('enforces mode invariant: opt_out iff writeback_opt_in true', () => {
    const falseData = buildInstitutionSettingsData({ id: 'x', writebackOptIn: false });
    const trueData = buildInstitutionSettingsData({ id: 'x', writebackOptIn: true });
    expect(falseData.remediation_delivery.mode === 'opt_out').toBe(
      falseData.remediation_delivery.writeback_opt_in,
    );
    expect(trueData.remediation_delivery.mode === 'opt_out').toBe(
      trueData.remediation_delivery.writeback_opt_in,
    );
  });
});

describe('parsePatchInstitutionSettingsBody', () => {
  it('accepts opt_in', () => {
    const b = parsePatchInstitutionSettingsBody({
      remediation_delivery: { mode: 'opt_in' },
    });
    expect(b.remediation_delivery.mode).toBe('opt_in');
  });

  it('accepts opt_out', () => {
    const b = parsePatchInstitutionSettingsBody({
      remediation_delivery: { mode: 'opt_out' },
    });
    expect(b.remediation_delivery.mode).toBe('opt_out');
  });

  it('throws 400 for invalid mode', () => {
    expect(() =>
      parsePatchInstitutionSettingsBody({ remediation_delivery: { mode: 'invalid' } }),
    ).toThrow();
  });

  it('throws 400 for missing remediation_delivery', () => {
    expect(() => parsePatchInstitutionSettingsBody({})).toThrow();
  });

  it('throws 400 for missing mode', () => {
    expect(() =>
      parsePatchInstitutionSettingsBody({ remediation_delivery: {} }),
    ).toThrow();
  });
});
