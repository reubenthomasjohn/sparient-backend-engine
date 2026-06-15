import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { makeInstitution } from '../../fixtures';
import { CanvasSourceClient } from '../../../src/services/sources/canvas/CanvasSourceClient';
import { CanvasClient } from '../../../src/services/sources/canvas/CanvasClient';
import type { CanvasCourse, CanvasTerm } from '../../../src/types/canvas';

// We mock the constructor so the client can stub at the CanvasClient seam.
// This lets us drive (term, course) shapes directly into getCourses without
// touching axios.
vi.mock('../../../src/services/sources/canvas/CanvasClient');

let mockedClient: DeepMockProxy<CanvasClient>;

beforeEach(() => {
  mockedClient = mockDeep<CanvasClient>();
  vi.mocked(CanvasClient).mockImplementation(() => mockedClient as unknown as CanvasClient);
  // accountId is a property accessed by getCourses' logger call.
  Object.defineProperty(mockedClient, 'accountId', { value: '1', configurable: true });
});

function term(overrides: Partial<CanvasTerm> = {}): CanvasTerm {
  return {
    id: 1,
    name: 'Term',
    start_at: null,
    end_at: null,
    workflow_state: 'active',
    ...overrides,
  };
}

function course(termId: number, overrides: Partial<CanvasCourse> = {}): CanvasCourse {
  return {
    id: 100 + termId,
    name: `Course in term ${termId}`,
    course_code: `C-${termId}`,
    enrollment_term_id: termId,
    workflow_state: 'available',
    ...overrides,
  };
}

async function runWith(opts: { terms: CanvasTerm[]; courses: CanvasCourse[] }) {
  mockedClient.getPaginated.mockResolvedValue(opts.courses);
  mockedClient.getTerms.mockResolvedValue(opts.terms);
  const client = new CanvasSourceClient(makeInstitution());
  return client.getCourses();
}

describe('CanvasSourceClient.getCourses — term filter', () => {
  // Use a fixed "now" via fake timers so date comparisons are deterministic.
  const NOW = new Date('2026-04-29T12:00:00Z');
  const PAST = new Date('2026-01-01T00:00:00Z');
  const FUTURE = new Date('2026-12-31T00:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('treats both-NULL term as always-active (Canvas Default Term)', async () => {
    // Canvas's "Default Term" canonically has both start_at and end_at = null.
    // Per Canvas source: enrollment_term has no presence validation on these,
    // so this is the always-active fallback.
    const result = await runWith({
      terms: [term({ id: 1, start_at: null, end_at: null })],
      courses: [course(1)],
    });
    expect(result).toHaveLength(1);
  });

  it('treats start_at=NULL with future end_at as active (no defined start)', async () => {
    const result = await runWith({
      terms: [term({ id: 1, start_at: null, end_at: FUTURE.toISOString() })],
      courses: [course(1)],
    });
    expect(result).toHaveLength(1);
  });

  it('treats end_at=NULL with past start_at as active (open-ended ongoing term)', async () => {
    const result = await runWith({
      terms: [term({ id: 1, start_at: PAST.toISOString(), end_at: null })],
      courses: [course(1)],
    });
    expect(result).toHaveLength(1);
  });

  it('treats start_at=NULL with past end_at as INACTIVE (term ended)', async () => {
    const result = await runWith({
      terms: [term({ id: 1, start_at: null, end_at: PAST.toISOString() })],
      courses: [course(1)],
    });
    expect(result).toHaveLength(0);
  });

  it('treats end_at=NULL with future start_at as INACTIVE (term not yet started)', async () => {
    const result = await runWith({
      terms: [term({ id: 1, start_at: FUTURE.toISOString(), end_at: null })],
      courses: [course(1)],
    });
    expect(result).toHaveLength(0);
  });

  it('excludes a course that points to a term not in the fetched list (orphan)', async () => {
    // Defensive: even though Canvas validates enrollment_term_id presence, a
    // term-id pointing to a deleted/unfetched term must not crash or sneak in.
    const result = await runWith({
      terms: [term({ id: 1, start_at: null, end_at: null })], // active
      courses: [course(999)], // points to nonexistent term
    });
    expect(result).toHaveLength(0);
  });

  it('keeps courses in active terms; drops courses in inactive terms (mixed)', async () => {
    const result = await runWith({
      terms: [
        term({ id: 1, start_at: null, end_at: null }), // default — active
        term({ id: 2, start_at: PAST.toISOString(), end_at: PAST.toISOString() }), // ended
        term({ id: 3, start_at: FUTURE.toISOString(), end_at: FUTURE.toISOString() }), // not started
      ],
      courses: [course(1), course(2), course(3)],
    });
    expect(result.map((c) => c.termId).sort()).toEqual(['1']);
  });

  it('treats start_at exactly equal to now as active (strict >)', async () => {
    // The current logic uses `>` not `>=`, so a term whose start is *exactly*
    // now is considered active. Lock this behaviour in.
    const result = await runWith({
      terms: [term({ id: 1, start_at: NOW.toISOString(), end_at: FUTURE.toISOString() })],
      courses: [course(1)],
    });
    expect(result).toHaveLength(1);
  });

  it('treats end_at exactly equal to now as active (strict <)', async () => {
    const result = await runWith({
      terms: [term({ id: 1, start_at: PAST.toISOString(), end_at: NOW.toISOString() })],
      courses: [course(1)],
    });
    expect(result).toHaveLength(1);
  });

  it('maps course states to Canvas state[] values (unpublished -> created/claimed), no enrollment_type', async () => {
    // Canvas has no "unpublished" state value — sending it matches zero courses.
    // The default allowlist (available + unpublished) must reach Canvas as
    // available + created + claimed. enrollment_type was also removed (undocumented
    // on this endpoint, dropped courses for some tokens).
    await runWith({ terms: [], courses: [] });
    const [, params] = mockedClient.getPaginated.mock.calls[0];
    expect(params).toEqual({ state: ['available', 'created', 'claimed'] });
    expect(params).not.toHaveProperty('enrollment_type');
  });
});

describe('CanvasSourceClient.getCourses — allowedTermIds override', () => {
  it('syncs ONLY the configured terms (bypassing the active-term check), incl. concluded', async () => {
    const PAST = new Date('2020-01-01T00:00:00Z');
    mockedClient.getPaginated.mockResolvedValue([
      course(7), // configured term
      course(8), // not configured
    ]);
    // Term 7 is concluded (would be dropped by the active-term filter) but is allow-listed.
    mockedClient.getTerms.mockResolvedValue([
      term({ id: 7, start_at: PAST.toISOString(), end_at: PAST.toISOString() }),
      term({ id: 8, start_at: null, end_at: null }),
    ]);
    const client = new CanvasSourceClient(
      makeInstitution({ syncConfig: { allowedTermIds: ['7'] } }),
    );
    const result = await client.getCourses();
    expect(result.map((c) => c.termId)).toEqual(['7']);
  });
});

describe('CanvasSourceClient.getCourse — direct single-course fetch', () => {
  it('returns the mapped course (no listing/term filters applied)', async () => {
    mockedClient.getCourse.mockResolvedValue(course(99, { id: 2022437, name: 'Direct' }));
    const client = new CanvasSourceClient(makeInstitution());
    const result = await client.getCourse('2022437');
    expect(result).toEqual({
      externalId: '2022437',
      name: 'Direct',
      courseCode: 'C-99',
      termId: '99',
    });
    expect(mockedClient.getCourse).toHaveBeenCalledWith('2022437');
  });

  it('returns null when Canvas has no such course', async () => {
    mockedClient.getCourse.mockResolvedValue(null);
    const client = new CanvasSourceClient(makeInstitution());
    expect(await client.getCourse('nope')).toBeNull();
  });
});
