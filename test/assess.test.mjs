import test from 'node:test';
import assert from 'node:assert/strict';
import { assess, workspaceRequirement } from '../lib/assess.mjs';

const at = '2026-10-20T12:00:00Z';
const criteria = ['stable_surface', 'laptop_space', 'compatible_seat', 'legroom'];
const obs = (values) => Object.entries(values).map(([criterion, value]) => ({
  criterion, value, detail: `Observed ${criterion}: ${value}`,
}));
function evidence(values, extra = {}) {
  return {
    id: 'photo-1', listing_id: '123', method: 'visual', observed_at: at,
    source: { type: 'photo', url: 'https://a0.muscache.com/im/pictures/example.jpg' },
    observations: obs(values), ...extra,
  };
}
function packet(e = [], requirements = [workspaceRequirement()]) {
  return { listing_id: '123', requirements, evidence: e, as_of: at };
}
const yes = Object.fromEntries(criteria.map(k => [k, 'yes']));

test('supplied narrow-table observations cannot verify compatible seating or legroom', () => {
  const result = assess(packet([evidence({
    stable_surface: 'yes', laptop_space: 'unknown',
    compatible_seat: 'unknown', legroom: 'unknown',
  })]));
  assert.equal(result.eligible, false);
  assert.equal(result.status, 'needs_evidence');
  assert.equal(result.requirements[0].status, 'unknown');
  assert.deepEqual(result.requirements[0].missing, ['laptop_space', 'compatible_seat', 'legroom']);
});
test('clear dining table and compatible chair pass without requiring an office chair', () => {
  const result = assess(packet([evidence(yes)]));
  assert.equal(result.eligible, true);
  assert.equal(result.requirements[0].status, 'met');
  assert.equal(result.basis, 'assessment_of_supplied_evidence');
  assert.equal(result.evidence[0].method, 'visual');
});
test('generic dedicated-workspace label cannot verify a physical arrangement', () => {
  const result = assess(packet([evidence(yes, {
    method: 'amenity_label', source: { type: 'listing', url: 'https://www.airbnb.com/rooms/123' },
  })]));
  assert.equal(result.eligible, false);
  assert.equal(result.requirements[0].status, 'unknown');
});
test('evidence for another property does not satisfy this property', () => {
  assert.equal(assess(packet([evidence(yes, { listing_id: '456' })])).eligible, false);
});
test('specific listing text can support the arrangement while retaining its method', () => {
  const result = assess(packet([evidence(yes, {
    method: 'specific_text',
    source: { type: 'listing', url: 'https://www.airbnb.com/rooms/123' },
  })]));
  assert.equal(result.eligible, true);
  assert.equal(result.evidence[0].method, 'specific_text');
});
test('conflicting positive and negative evidence remains visible and blocks eligibility', () => {
  const result = assess(packet([
    evidence(yes),
    evidence({ compatible_seat: 'no' }, { id: 'photo-2' }),
  ]));
  assert.equal(result.eligible, false);
  assert.equal(result.requirements[0].status, 'conflict');
  assert.deepEqual(result.requirements[0].evidence_ids, ['photo-1', 'photo-2']);
});
test('clear failure is not silently downgraded to absence of evidence', () => {
  const result = assess(packet([evidence({ ...yes, legroom: 'no' })]));
  assert.equal(result.status, 'not_met');
  assert.equal(result.requirements[0].status, 'not_met');
});
test('no photos or observations means unknown, not no workspace', () => {
  assert.equal(assess(packet()).requirements[0].status, 'unknown');
});
test('a preference does not disqualify an otherwise verified required condition', () => {
  const result = assess(packet([evidence(yes)], [
    workspaceRequirement(),
    { id: 'view', required: false, criteria: ['forest_view'] },
  ]));
  assert.equal(result.eligible, true);
  assert.equal(result.requirements[1].status, 'unknown');
});
test('standing is an explicit alternative, not an automatic exception', () => {
  const e = evidence({ stable_surface: 'yes', laptop_space: 'yes', standing_height: 'yes' });
  const requirements = [{
    id: 'workspace', required: true,
    criteria: ['stable_surface', 'laptop_space', 'standing_height'],
  }];
  assert.equal(assess(packet([e], requirements)).eligible, true);
});
test('expired evidence cannot verify a current requirement', () => {
  const result = assess(packet([evidence(yes, { expires_at: '2026-10-19T12:00:00Z' })]));
  assert.equal(result.eligible, false);
  assert.match(result.warnings.join(' '), /expired/);
});
test('unknown boolean-like values are rejected rather than treated as truthy', () => {
  assert.throws(() => assess(packet([evidence({ stable_surface: 'false' })])), /value/);
});
test('missing detail, source or timestamp cannot become verified evidence', () => {
  for (const patch of [{ source: {} }, { observed_at: 'nonsense' }, {
    observations: [{ criterion: 'stable_surface', value: 'yes', detail: '' }],
  }]) {
    assert.throws(() => assess(packet([evidence(yes, patch)])), /evidence|source|observed_at|detail/);
  }
});
test('duplicate ids and empty requirements are rejected', () => {
  assert.throws(() => assess(packet([evidence(yes), evidence(yes)])), /duplicate/);
  assert.throws(() => assess(packet([], [])), /requirements/);
});
test('observations are scoped to each requirement, with no global pass by one amenity', () => {
  const result = assess(packet([evidence(yes)], [
    workspaceRequirement(),
    { id: 'sauna', required: true, criteria: ['private_sauna', 'guest_access'] },
  ]));
  assert.equal(result.eligible, false);
  assert.equal(result.requirements[0].status, 'met');
  assert.equal(result.requirements[1].status, 'unknown');
});
test('shared criterion names cannot make apartment privacy prove sauna privacy', () => {
  const e = evidence({ private: 'yes' }, {
    method: 'specific_text',
    source: { type: 'listing', url: 'https://www.airbnb.com/rooms/123' },
  });
  assert.throws(() => assess(packet([e], [
    { id: 'accommodation', required: true, criteria: ['private'] },
    { id: 'sauna', required: true, criteria: ['private'] },
  ])), /criterion.*unique|duplicate.*criteri/i);
});
test('distinct privacy criteria preserve supported and unsupported conditions', () => {
  const result = assess(packet([evidence({ accommodation_private: 'yes' }, {
    method: 'specific_text',
    source: { type: 'listing', url: 'https://www.airbnb.com/rooms/123' },
  })], [
    { id: 'accommodation', required: true, criteria: ['accommodation_private'] },
    { id: 'sauna', required: true, criteria: ['sauna_private'] },
  ]));
  assert.equal(result.requirements[0].status, 'met');
  assert.equal(result.requirements[1].status, 'unknown');
  assert.equal(result.eligible, false);
});
test('a requirement override cannot be silently ignored', () => {
  const result = assess(packet([evidence(yes)]), [
    { id: 'wifi', required: true, criteria: ['wifi_measured'] },
  ]);
  assert.equal(result.requirements[0].id, 'wifi');
  assert.equal(result.eligible, false);
});
test('visual method requires a photo source, not an unseen listing URL', () => {
  assert.throws(() => assess(packet([evidence(yes, {
    source: { type: 'listing', url: 'https://www.airbnb.com/rooms/123' },
  })])), /visual/);
});
